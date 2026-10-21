import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireLock, readJson, atomicJson } from './storage.js';
import { validateDeck, validateConfig, validateState, progress, hash, ROOM, isId, iso, MAX_ATTEMPTS, requestFor, observeQuestion, assertParticipantRoom } from './model.js';

const active = (state) => ['creating', 'pending'].includes(state.attempts.at(-1)?.status) ? state.attempts.at(-1) : null;
export function report(state, deck) {
  const pending = active(state);
  return { status: pending?.status === 'creating' ? 'create_unknown' : pending ? 'pending' : 'idle',
    deckHash: state.deckHash, participant: state.config.participant, attemptCount: state.attempts.length,
    activeAttemptId: pending?.id ?? null, questionId: pending?.questionId ?? null, cards: progress(state, deck) };
}

/** One create or read cycle. Remote creation is never retried automatically. */
export async function practice({ client, directory, deck: rawDeck, config: rawConfig, token, room, command = 'run', attachId, retryId,
  now = () => new Date().toISOString(), signal, write = atomicJson }) {
  const deck = validateDeck(rawDeck), config = validateConfig(rawConfig);
  if (typeof token !== 'string' || !token || typeof room !== 'string' || !ROOM.test(room)) throw new Error('A complete connection is required.');
  if (!['run', 'recover', 'find', 'retry'].includes(command) || attachId !== undefined && !isId(attachId) || retryId !== undefined && !isId(retryId)) throw new Error('Invalid operation or UUID.');
  const release = await acquireLock(directory);
  try {
    signal?.throwIfAborted();
    let state = await readJson(join(directory, 'state.json'));
    const observedAt = iso(now());
    if (state !== null) {
      validateState(state, deck);
      if (state.credentialHash !== hash(token) || state.room !== room || hash(state.config) !== hash(config)) throw new Error('State belongs to another connection, room, or participant.');
    } else {
      if (command !== 'run') throw new Error('No existing practice session to recover.');
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      state = { version: 1, deckHash: hash(deck), config, room, credentialHash: hash(token), startedAt: observedAt, attempts: [] };
      await write(directory, 'state.json', state);
    }
    const save = async (next) => { validateState(next, deck); await write(directory, 'state.json', next); state = next; };
    const finish = (status, attemptId) => ({ ...report(state, deck), status, attemptId: attemptId ?? null });
    if (command === 'retry') {
      const attempt = state.attempts.find((item) => item.id === retryId);
      if (!attempt || !['expired', 'cancelled', 'invalid_answer'].includes(attempt.status)
        || state.attempts.filter((item) => item.cardId === attempt.cardId).at(-1).id !== retryId) throw new Error('Retry requires the latest paused attempt for that card.');
      if (attempt.retryAt === null) await save({ ...state, attempts: state.attempts.map((item) => item.id === retryId ? { ...item, retryAt: observedAt } : item) });
      return finish('retry_ready', retryId);
    }
    let attempt = active(state);
    if (command === 'find') {
      if (attempt?.status !== 'creating') throw new Error('No uncertain creation needs an ID search.');
      const questions = await client.questions.list({ state: 'all' });
      if (!Array.isArray(questions) || questions.length > 100) throw new Error('Question list exceeds the bounded recent window.');
      const candidates = [];
      for (const question of questions) {
        try { observeQuestion(question, attempt.request, question.id, room, iso(now())); candidates.push({ id: question.id, state: question.state }); }
        catch { /* Only exact matches are candidates; no-match does not prove absence. */ }
      }
      return { ...finish('create_unknown', attempt.id), candidates };
    }
    if (command === 'recover' && (!attempt || !attachId)) throw new Error('Recovery requires an existing active attempt and exact Question UUID.');
    if (attempt?.status === 'creating' && command !== 'recover') return finish('create_unknown', attempt.id);
    let question;
    if (attempt) {
      if (attempt.questionId && attachId && attachId !== attempt.questionId) throw new Error('This attempt already tracks a different Question.');
      question = await client.questions.get(attempt.questionId ?? attachId);
    } else {
      const candidate = progress(state, deck).filter((card) => !card.paused && card.dueAt <= observedAt)
        .sort((a, b) => a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.cardId < b.cardId ? -1 : 1)[0];
      if (!candidate) return finish('not_due');
      if (state.attempts.length >= MAX_ATTEMPTS) throw new Error('Practice history reached 200 attempts. Archive only after resolving active work.');
      assertParticipantRoom(await client.rooms.list(), room, config.participant.id);
      signal?.throwIfAborted();
      const id = randomUUID();
      attempt = { id, cardId: candidate.cardId, createdAt: observedAt, request: requestFor(deck, config, candidate.cardId, id),
        questionId: null, status: 'creating', observation: null, retryAt: null };
      const reserved = { ...state, attempts: [...state.attempts, attempt] };
      // Leave space for the bounded server observation before issuing a send.
      if (Buffer.byteLength(JSON.stringify(reserved, null, 2)) + 4096 > 1024 * 1024) throw new Error('Insufficient state capacity for a new question.');
      await save(reserved);
      signal?.throwIfAborted();
      try { question = await client.questions.ask(room, attempt.request); }
      catch { return finish('create_unknown', attempt.id); }
    }
    signal?.throwIfAborted();
    const expectedId = attempt.questionId ?? attachId ?? question?.id;
    const observation = observeQuestion(question, attempt.request, expectedId, room, iso(now()));
    if (attempt.observation && (observation.observation.createdAt !== attempt.observation.createdAt || observation.observation.expiresAt !== attempt.observation.expiresAt
      || observation.observation.askerId !== attempt.observation.askerId)) throw new Error('Question identity or timing changed after its first observation.');
    attempt = { ...attempt, questionId: expectedId, ...observation };
    await save({ ...state, attempts: state.attempts.map((item) => item.id === attempt.id ? attempt : item) });
    return finish(attempt.status, attempt.id);
  } finally { await release(); }
}

export async function localStatus(directory, deck) {
  const release = await acquireLock(directory);
  try {
    const state = await readJson(join(directory, 'state.json'));
    if (state === null) return { status: 'not_started' };
    validateState(state, deck); return report(state, deck);
  } finally { await release(); }
}
