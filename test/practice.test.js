import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { practice, localStatus } from '../src/practice.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateDeck, validateState, requestFor, observeQuestion, progress, hash, iso } from '../src/model.js';
import { loadConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/deck.json', import.meta.url), 65536);
const singleDeck = () => ({ ...structuredClone(example), cards: [structuredClone(example.cards[0])] });
async function setup(t, deck = singleDeck()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-practice-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, deck, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => practice({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;

test('real SDK asks one due card, resumes it, grades correct and stays not due on replay', async (t) => {
  const s = await setup(t); let result = await s.run();
  assert.equal(result.status, 'pending'); assert.equal(sends(s.api), 1);
  assert.equal((await s.run()).status, 'pending'); assert.equal(sends(s.api), 1);
  s.api.answer(result.questionId, 'get'); result = await s.run();
  assert.equal(result.status, 'graded'); assert.equal(result.cards[0].lastResult.correct, true);
  assert.equal(result.cards[0].dueAt, '2026-01-04T09:00:00.000Z');
  const calls = s.api.calls.length;
  assert.equal((await s.run()).status, 'not_due'); assert.equal(s.api.calls.length, calls);
  assert.equal((await stat(join(s.directory, 'state.json'))).mode & 0o777, 0o600);
});

test('correct streak uses 3 then 7 days; wrong answer resets to one day', async (t) => {
  const s = await setup(t);
  for (const [answer, days, streak] of [['get', 3, 1], ['get', 7, 2], ['post', 1, 0], ['get', 3, 1]]) {
    const started = await s.run(); s.api.answer(started.questionId, answer);
    const graded = await s.run(); const card = graded.cards[0];
    assert.equal(card.lastResult.intervalDays, days); assert.equal(card.correctStreak, streak);
    assert.equal(Date.parse(card.dueAt) - Date.parse(s.clock.value), days * 86400000);
    s.clock.value = card.dueAt;
  }
});

test('deck chooses one card at a time and keeps one active question across cards', async (t) => {
  const s = await setup(t, structuredClone(example));
  const first = await s.run(); assert.equal(s.api.questions.size, 1);
  await s.run(); assert.equal(s.api.questions.size, 1);
  const cardId = (await s.saved()).attempts[0].cardId;
  s.api.answer(first.questionId, example.cards.find((card) => card.id === cardId).correct);
  await s.run(); await s.run(); assert.equal(s.api.questions.size, 2);
});

test('lost creation response never resends; exact candidate recovery grades the original', async (t) => {
  const s = await setup(t); s.api.controls.loseNext = true;
  let result = await s.run(); assert.equal(result.status, 'create_unknown');
  result = await s.run(); assert.equal(result.status, 'create_unknown'); assert.equal(sends(s.api), 1);
  const candidates = await s.run({ command: 'find' }); assert.equal(candidates.candidates.length, 1);
  const questionId = candidates.candidates[0].id; s.api.answer(questionId, 'get');
  result = await s.run({ command: 'recover', attachId: questionId });
  assert.equal(result.status, 'graded'); assert.equal(sends(s.api), 1);
});

test('malformed creation response keeps reserved request and requires recovery', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true;
  await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating');
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('empty candidate list is not evidence creation failed', async (t) => {
  const s = await setup(t); s.api.controls.loseNext = true; await s.run(); s.api.questions.clear();
  const result = await s.run({ command: 'find' }); assert.deepEqual(result.candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('expired and cancelled are ungraded, paused, and require explicit retry', async (t) => {
  for (const terminal of ['expired', 'cancelled']) {
    const s = await setup(t); const started = await s.run();
    if (terminal === 'expired') s.clock.value = '2026-01-01T09:15:01.000Z';
    s.api.terminal(started.questionId, terminal);
    let result = await s.run(); assert.equal(result.status, terminal);
    assert.equal(result.cards[0].lastResult, null); assert.equal(result.cards[0].paused, true);
    assert.equal((await s.run()).status, 'not_due'); assert.equal(sends(s.api), 1);
    result = await s.run({ command: 'retry', retryId: started.attemptId }); assert.equal(result.status, 'retry_ready');
    await s.run({ command: 'retry', retryId: started.attemptId }); assert.equal(sends(s.api), 1);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('wrong responder, redacted identity, typed reply and unknown option never count as incorrect', async (t) => {
  for (const modify of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'get'; }, (q) => { q.answer.value = 'unknown'; },
  ]) {
    const s = await setup(t); const started = await s.run(); s.api.answer(started.questionId, 'get');
    modify(s.api.questions.get(started.questionId));
    const result = await s.run(); assert.equal(result.status, 'invalid_answer');
    assert.equal(result.cards[0].lastResult, null); assert.equal(result.cards[0].correctStreak, 0);
  }
});

test('request, room, handoff and participant mismatches retain pending attempt', async (t) => {
  for (const modify of [
    (q) => { delete q.is_handoff; }, (q) => { q.is_handoff = true; },
    (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.target_user_id = OTHER; },
    (q) => { q.prompt = 'Other prompt'; }, (q) => { q.resolution_policy = 'all'; },
    (q) => { q.options.reverse(); }, (q) => { q.data.card_id = 'other'; },
  ]) {
    const s = await setup(t); const started = await s.run(); modify(s.api.questions.get(started.questionId));
    await assert.rejects(s.run()); assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal(sends(s.api), 1);
  }
});

test('asker or original lifetime change on later reads is rejected', async (t) => {
  for (const modify of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); const started = await s.run(); modify(s.api.questions.get(started.questionId));
    await assert.rejects(s.run(), /identity or timing/);
  }
});

test('answer and resolution timestamps must agree and stay within the Question lifetime', async (t) => {
  const s = await setup(t); const started = await s.run(); s.api.answer(started.questionId, 'get');
  const q = s.api.questions.get(started.questionId); q.answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).status, 'invalid_answer');
  const other = await setup(t); const pending = await other.run(); other.api.answer(pending.questionId, 'get');
  const expiredAnswer = other.api.questions.get(pending.questionId);
  expiredAnswer.answer.answered_at = expiredAnswer.resolved_at = '2026-01-01T09:16:00.000Z';
  other.clock.value = '2026-01-01T09:16:00.000Z';
  await assert.rejects(other.run(), /resolution time/);
});

test('clock skew is bounded and observations use the clock after the network response', async (t) => {
  const s = await setup(t); let result = await s.run();
  const request = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(result.questionId, 'get'); return request(...args); };
  result = await s.run(); assert.equal(result.status, 'graded');
  assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  const other = await setup(t); const pending = await other.run();
  const q = other.api.questions.get(pending.questionId);
  q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z';
  await assert.rejects(other.run(), /future/);
});

test('UTC Z and +00:00 timestamps normalize; invalid calendar dates and offsets fail', () => {
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z');
  assert.throws(() => iso('2026-02-30T09:00:00Z')); assert.throws(() => iso('2026-01-01T09:00:00+04:00'));
});

test('TTL mismatch and answer on pending response fail', async (t) => {
  const s = await setup(t); const result = await s.run(); const q = s.api.questions.get(result.questionId);
  q.expires_at = '2026-01-01T10:00:00.000Z'; await assert.rejects(s.run(), /lifetime/);
  q.expires_at = '2026-01-01T09:15:00.000Z'; q.answer = {};
  await assert.rejects(s.run(), /unexpected answer/);
});

test('changed deck revision, content, participant or credential cannot reuse history', async (t) => {
  const s = await setup(t); await s.run();
  await assert.rejects(s.run({ deck: { ...s.options.deck, version: 2 } }), /changed deck/);
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  await assert.rejects(s.run({ token: 'different' }), /another connection/);
  const modified = structuredClone(s.options.deck); modified.cards[0].correct = 'post';
  await assert.rejects(s.run({ deck: modified }), /changed deck/); assert.equal(sends(s.api), 1);
});

test('malformed decks reject duplicate cards, options, unknown keys and missing correct answer', () => {
  for (const mutate of [
    (deck) => { deck.cards.push(deck.cards[0]); }, (deck) => { deck.cards[0].options[1] = deck.cards[0].options[0]; },
    (deck) => { deck.cards[0].correct = 'missing'; }, (deck) => { deck.version = '1'; }, (deck) => { deck.script = 'anything'; },
  ]) { const deck = singleDeck(); mutate(deck); assert.throws(() => validateDeck(deck)); }
});

test('room preflight rejects missing participant and public rooms before any POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; grade write failure resumes the same question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0);
  const result = await s.run(); s.api.answer(result.questionId, 'get');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending');
  assert.equal((await s.run()).status, 'graded'); assert.equal(sends(s.api), 1);
});

test('post-create save failure preserves uncertainty and can recover without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'creating'); assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('API reads fail without altering the saved attempt', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run());
  assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
});

test('state validation rejects request tampering, duplicate IDs and forged grade shape', async (t) => {
  const s = await setup(t); const started = await s.run(); s.api.answer(started.questionId, 'get'); await s.run();
  const saved = await s.saved();
  const request = structuredClone(saved); request.attempts[0].request.ttl = 60; assert.throws(() => validateState(request, s.options.deck));
  const duplicate = structuredClone(saved); duplicate.attempts.push(duplicate.attempts[0]); assert.throws(() => validateState(duplicate, s.options.deck));
  const grade = structuredClone(saved); grade.attempts[0].observation.answer.responderId = OTHER; assert.throws(() => validateState(grade, s.options.deck));
});

test('200 maximum-sized attempts fit the file cap; capacity blocks another remote question', async (t) => {
  const deck = singleDeck(); deck.cards[0].prompt = 'x'.repeat(400);
  deck.cards[0].options = Array.from({ length: 4 }, (_, i) => ({ value: `option_${i}`, label: `${i}${'x'.repeat(31)}` })); deck.cards[0].correct = 'option_0';
  const s = await setup(t, deck); const first = await s.run(); s.api.answer(first.questionId, 'option_0'); await s.run();
  const saved = await s.saved(), template = saved.attempts[0];
  saved.attempts = Array.from({ length: 200 }, (_, index) => {
    const attemptId = id(index + 1000); return { ...structuredClone(template), id: attemptId, questionId: id(index + 2000), request: requestFor(deck, CONFIG, deck.cards[0].id, attemptId) };
  });
  validateState(saved, deck);
  assert.ok(Buffer.byteLength(JSON.stringify(saved, null, 2)) + 4096 < 1024 * 1024);
  await atomicJson(s.directory, 'state.json', saved); s.clock.value = progress(saved, deck)[0].dueAt;
  const before = sends(s.api); await assert.rejects(s.run(), /200 attempts/); assert.equal(sends(s.api), before);
});

test('bounded file reads reject oversized, malformed and symlink state without exposing content', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes another command and status stays fully offline', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localStatus(s.directory, s.options.deck), /lock exists/);
  await release(); const before = s.api.calls.length; assert.equal((await localStatus(s.directory, s.options.deck)).status, 'pending');
  assert.equal(s.api.calls.length, before);
});

test('partial and blank environment overrides never fall back to saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' }));
  await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport refuses unrelated writes, redirects and oversized response bodies', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1);
  await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const oversized = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) });
  await assert.rejects(oversized.questions.get(id(1)));
});

test('transport bounds stalled fetch/body and yields to abort on infinitely ready empty chunks', async () => {
  const fetchHang = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(fetchHang.questions.get(id(1)));
  const bodyHang = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) });
  await assert.rejects(bodyHang.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('cancellation before creation sends nothing; after reservation preserves unknown state', async (t) => {
  const s = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(s.run({ signal: controller.signal })); assert.equal(sends(s.api), 0);
  const other = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: other.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) other.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});
