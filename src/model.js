import { createHash } from 'node:crypto';

export const TTL = 900;
export const MAX_ATTEMPTS = 200;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}

export function validateDeck(deck) {
  if (!keys(deck, ['deckId', 'version', 'cards']) || !word(deck.deckId) || !Number.isSafeInteger(deck.version) || deck.version < 1
    || !Array.isArray(deck.cards) || deck.cards.length < 1 || deck.cards.length > 20) throw new Error('Deck requires a stable ID, positive version, and 1–20 cards.');
  for (const card of deck.cards) {
    if (!keys(card, ['id', 'prompt', 'options', 'correct']) || !word(card.id) || !line(card.prompt, 400)
      || !Array.isArray(card.options) || card.options.length < 2 || card.options.length > 4
      || card.options.some((option) => !keys(option, ['value', 'label']) || !word(option.value) || !line(option.label, 32))
      || new Set(card.options.map((option) => option.value)).size !== card.options.length
      || new Set(card.options.map((option) => option.label)).size !== card.options.length
      || !card.options.some((option) => option.value === card.correct)) throw new Error('Invalid card, options, or correct answer.');
  }
  if (new Set(deck.cards.map((card) => card.id)).size !== deck.cards.length) throw new Error('Duplicate card ID.');
  return structuredClone(deck);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact participant UUID and label.');
  return structuredClone(config);
}

export function requestFor(deck, config, cardId, attemptId) {
  const card = deck.cards.find((item) => item.id === cardId);
  if (!card || !isId(attemptId)) throw new Error('Invalid card or attempt.');
  const key = `practice-${attemptId}`;
  return {
    prompt: `Practice: ${card.prompt}`, context: `Practice ${hash({ deck, cardId }).slice(0, 20)}`,
    options: card.options.map((option) => ({ ...option, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL,
    correlation_id: key, data: { deck_hash: hash(deck), card_id: cardId, attempt_id: attemptId }, idempotencyKey: key,
  };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly far in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'graded') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved grade evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered attempts must not contain grade evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id)
    || q.prompt !== request.prompt || q.context !== request.context || q.responder_scope !== 'direct'
    || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first' || q.text_input !== null
    || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved request, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'graded', request); status = 'graded';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function validateState(state, deck) {
  validateDeck(deck);
  if (!keys(state, ['version', 'deckHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.deckHash !== hash(deck) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > MAX_ATTEMPTS || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed deck. Restore the original files or archive a completed learning history.');
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'cardId', 'createdAt', 'request', 'questionId', 'status', 'observation', 'retryAt'])
      || !isId(attempt.id) || ids.has(attempt.id) || !deck.cards.some((card) => card.id === attempt.cardId)
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(deck, state.config, attempt.cardId, attempt.id))
      || !['creating', 'pending', 'graded', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved attempt.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last attempt may be active.');
    if (attempt.retryAt !== null && (!['expired', 'cancelled', 'invalid_answer'].includes(attempt.status)
      || iso(attempt.retryAt) !== attempt.retryAt || attempt.retryAt < attempt.createdAt)) throw new Error('Invalid explicit retry record.');
  }
  return state;
}

export function progress(state, deck) {
  validateState(state, deck);
  return deck.cards.map((card) => {
    let streak = 0, dueAt = state.startedAt, paused = false, lastAttemptId = null, lastResult = null;
    for (const attempt of state.attempts.filter((entry) => entry.cardId === card.id)) {
      lastAttemptId = attempt.id;
      if (attempt.status === 'graded') {
        const correct = attempt.observation.answer.value === card.correct;
        streak = correct ? Math.min(streak + 1, 2) : 0;
        const intervalDays = correct ? streak === 1 ? 3 : 7 : 1;
        dueAt = new Date(Date.parse(attempt.observation.answer.answeredAt) + intervalDays * 86400000).toISOString();
        paused = false;
        lastResult = { correct, selectedLabel: attempt.observation.answer.label,
          correctLabel: card.options.find((option) => option.value === card.correct).label, intervalDays };
      } else if (['expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
        paused = attempt.retryAt === null; dueAt = attempt.retryAt; lastResult = null;
      }
    }
    return { cardId: card.id, dueAt, paused, correctStreak: streak, lastAttemptId, lastResult };
  });
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
