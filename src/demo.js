import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { practice } from './practice.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-practice-demo-'));
try {
  const example = await readJson(new URL('../examples/deck.json', import.meta.url), 65536);
  const deck = { ...example, cards: [example.cards[0]] };
  let clock = '2026-01-01T09:00:00.000Z';
  const now = () => clock, api = mockApi(now);
  const options = { ...api, client: api.client, directory, deck, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
  let result = await practice(options);
  api.answer(result.questionId, 'get');
  result = await practice(options);
  const first = result.cards[0];
  clock = first.dueAt;
  result = await practice(options);
  api.answer(result.questionId, 'post');
  result = await practice(options);
  console.log(JSON.stringify({ mode: 'offline SDK mock; no credentials or network',
    correctReview: { nextReviewAt: first.dueAt, intervalDays: first.lastResult.intervalDays },
    incorrectReview: { nextReviewAt: result.cards[0].dueAt, intervalDays: result.cards[0].lastResult.intervalDays },
    questionsCreated: api.questions.size,
  }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
