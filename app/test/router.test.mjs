import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { JevRouter, ROUTES, buildRequest, decide, parseAnswers } = require('../src/router.js');

const choice = (picked, confidence, options) => ({
  type: 'choice',
  choice: picked,
  confidence,
  probabilities: Object.fromEntries(options.map((o) => [o, o === picked ? confidence : (1 - confidence) / (options.length - 1)])),
});
const intent = (picked, confidence = 0.99) => choice(picked, confidence, ROUTES.intents);
const complexity = (picked, confidence = 0.99) => choice(picked, confidence, ['simple', 'complex']);
const noul = (value) => ({ type: 'noul', noul: value });

// What JevStation answers: the TypeSafe body inside a {data} envelope, plus credits.
function jevstation(answers) {
  return { data: { model: 'jev-1.13.0', answers, usage: { input_tokens: 450, output_tokens: 80 }, credits: { charged: 1, remaining: 45 } } };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function router(fetchImpl, options = {}) {
  return new JevRouter({ key: 'sk_test', url: 'https://jev.example/api/v1/systemone', fetchImpl, ...options });
}

test('the request asks intent and complexity, plus follow_up only with a previous exchange', () => {
  const alone = buildRequest('what time is it', null, 'jev-1.13.0');
  assert.equal(alone.model, 'jev-1.13.0');
  assert.deepEqual(alone.state, { voice_command: 'what time is it' });
  assert.deepEqual(Object.keys(alone.questions).sort(), ['complexity', 'intent']);
  assert.deepEqual(Object.keys(alone.questions.intent.criteria), ROUTES.intents);

  const previous = { command: 'list my downloads', reply: 'You have three files.' };
  const followUp = buildRequest('open the second one', previous, 'jev-1.13.0');
  assert.deepEqual(followUp.state, { voice_command: 'open the second one', previous_exchange: previous });
  assert.equal(followUp.questions.follow_up.type, 'noul');
});

test('parseAnswers reads both the JevStation envelope and the bare TypeSafe body', () => {
  const answers = { intent: intent('time') };
  assert.deepEqual(parseAnswers(jevstation(answers)).answers, answers);
  assert.equal(parseAnswers(jevstation(answers)).credits, 45);
  assert.deepEqual(parseAnswers({ model: 'jev-1.13.0', answers }).answers, answers);
  assert.equal(parseAnswers({ model: 'jev-1.13.0', answers }).credits, null);
  assert.throws(() => parseAnswers({ data: {} }), /no answers/);
});

test('a confident local intent is routed to its local handler', () => {
  for (const name of ['new_conversation', 'cancel', 'time', 'volume_up', 'volume_down', 'mute', 'unmute', 'gesture_on', 'gesture_off']) {
    const decision = decide({ intent: intent(name), complexity: complexity('simple') }, 0.5);
    assert.equal(decision.route, name);
  }
});

test('a confident browse intent is routed there, at the normal threshold', () => {
  assert.deepEqual(decide({ intent: intent('browse'), complexity: complexity('complex') }, 0.5), { route: 'browse', confidence: 0.99 });
  assert.equal(decide({ intent: intent('browse', 0.6) }, 0.5).route, 'browse');
  assert.deepEqual(decide({ intent: intent('browse', 0.4) }, 0.5), { route: 'agent', confidence: 0.4, reason: 'unsure' });
});

test('ending or resetting a command needs more confidence than answering it', () => {
  for (const name of ['cancel', 'new_conversation']) {
    assert.deepEqual(decide({ intent: intent(name, 0.8) }, 0.5), { route: 'agent', confidence: 0.8, reason: 'unsure' }, name);
    assert.equal(decide({ intent: intent(name, 0.9) }, 0.5).route, name);
  }
  assert.equal(decide({ intent: intent('time', 0.6) }, 0.5).route, 'time', 'a harmless route keeps the normal threshold');
  assert.equal(decide({ intent: intent('cancel', 0.9) }, 0.95).route, 'agent', 'a stricter configured threshold still wins');
});

test('an unsure intent falls back to the agent, as before Jev', () => {
  const decision = decide({ intent: intent('cancel', 0.4), complexity: complexity('simple') }, 0.5);
  assert.deepEqual(decision, { route: 'agent', confidence: 0.4, reason: 'unsure' });
});

test('a task is simple only when Jev is sure of it; anything else goes to the agent', () => {
  assert.equal(decide({ intent: intent('agent'), complexity: complexity('simple', 0.9) }, 0.5).route, 'simple');
  assert.equal(decide({ intent: intent('agent'), complexity: complexity('simple', 0.3) }, 0.5).route, 'agent');
  assert.deepEqual(decide({ intent: intent('agent', 0.97), complexity: complexity('complex', 0.08) }, 0.5), { route: 'agent', confidence: 0.97 }, 'the agent route reports how sure Jev is of the intent');
  assert.equal(decide({ intent: intent('agent') }, 0.5).route, 'agent');
});

test('a follow-up to the current conversation stays with the agent even when simple', () => {
  const answers = { intent: intent('agent'), complexity: complexity('simple'), follow_up: noul(0.8) };
  assert.deepEqual(decide(answers, 0.5), { route: 'agent', confidence: 0.99, reason: 'follow-up' });
  assert.equal(decide({ ...answers, follow_up: noul(0.2) }, 0.5).route, 'simple');
});

test('classify reports the follow-up probability when it was asked, for the journal', async () => {
  const answers = { intent: intent('agent'), complexity: complexity('complex'), follow_up: noul(0.31) };
  const r = router(async () => jsonResponse(jevstation(answers)));
  assert.equal((await r.classify('how big is it', { command: 'a', reply: 'b' })).followUp, 0.31);
  const alone = router(async () => jsonResponse(jevstation({ intent: intent('time') })));
  assert.equal((await alone.classify('what time is it', null)).followUp, null);
});

test('classify posts the question set with the bearer key and returns the decision', async () => {
  let call;
  const r = router(async (url, init) => {
    call = { url, init };
    return jsonResponse(jevstation({ intent: intent('agent'), complexity: complexity('simple', 0.97) }));
  });
  const decision = await r.classify('giá vàng hôm nay', null);
  assert.equal(call.url, 'https://jev.example/api/v1/systemone');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk_test');
  assert.equal(JSON.parse(call.init.body).state.voice_command, 'giá vàng hôm nay');
  assert.equal(decision.route, 'simple');
  assert.equal(decision.confidence, 0.97);
  assert.equal(decision.model, 'jev-1.13.0');
  assert.equal(decision.credits, 45);
  assert.ok(Number.isInteger(decision.ms) && decision.ms >= 0, 'how long Jev took');
});

test('an HTTP error falls back to the agent and says why', async () => {
  const r = router(async () => jsonResponse({ detail: { message: 'Cannot authenticate' } }, 401));
  const decision = await r.classify('hello', null);
  assert.equal(decision.route, 'agent');
  assert.equal(decision.reason, 'error');
  assert.match(decision.error, /401/);
  assert.match(decision.error, /Cannot authenticate/);
});

test('a network failure or malformed body falls back to the agent', async () => {
  const offline = await router(async () => {
    throw new TypeError('fetch failed');
  }).classify('hello', null);
  assert.deepEqual([offline.route, offline.reason, offline.error], ['agent', 'error', 'fetch failed']);

  const garbled = await router(async () => new Response('<html>', { status: 200 })).classify('hello', null);
  assert.deepEqual([garbled.route, garbled.reason], ['agent', 'error']);
});

test('a slow Jev times out and falls back to the agent', async () => {
  const r = router((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), { timeoutSeconds: 0.01 });
  const decision = await r.classify('hello', null);
  assert.deepEqual([decision.route, decision.reason, decision.error], ['agent', 'error', 'Jev timed out']);
});

test('a cancelled classification resolves to null so the caller drops it', async () => {
  const r = router((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = r.classify('hello', null);
  r.cancel();
  assert.equal(await pending, null);
});

test('a newer classification supersedes the older one', async () => {
  const answers = { intent: intent('time'), complexity: complexity('simple') };
  const r = router((_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    setTimeout(() => resolve(jsonResponse(jevstation(answers))), 5);
  }));
  const first = r.classify('one', null);
  const second = r.classify('two', null);
  assert.equal(await first, null);
  assert.equal((await second).route, 'time');
});

test('the router is disabled without a key, and never sends the key over plain http', () => {
  assert.equal(new JevRouter({ key: '', fetchImpl: () => assert.fail('no fetch') }).enabled, false);
  assert.equal(router(() => {}).enabled, true);
  const insecure = router(() => assert.fail('no fetch'), { url: 'http://jev.example/api/v1/systemone' });
  assert.equal(insecure.enabled, false);
  assert.match(insecure.disabledReason, /https/);
  assert.match(new JevRouter({ key: '' }).disabledReason, /JEV_API_KEY/);
  assert.equal(router(() => {}).disabledReason, '');
});

test('settings come from the environment with sane fallbacks', () => {
  const r = new JevRouter({ env: { JEV_API_KEY: 'k', FRIDAY_JEV_MIN_CONFIDENCE: 'abc', FRIDAY_JEV_TIMEOUT_S: '-1' } });
  assert.equal(r.key, 'k');
  assert.equal(r.url, 'https://jevstation.com/api/v1/systemone');
  assert.equal(r.model, 'jev-1.13.0');
  assert.equal(r.minConfidence, 0.5);
  assert.equal(r.timeoutMs, 8000);
  const tuned = new JevRouter({ env: { JEV_API_KEY: 'k', FRIDAY_JEV_URL: 'https://api.typesafe.ai/v1/systemone', FRIDAY_JEV_MIN_CONFIDENCE: '0.7' } });
  assert.equal(tuned.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(tuned.minConfidence, 0.7);
});
