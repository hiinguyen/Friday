import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { askJev, errorDetail, jevConfig, jevDisabledReason, parseAnswers } = require('../src/jev.js');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('jevConfig reads defaults and overrides', () => {
  assert.deepEqual(jevConfig({}), {
    key: '',
    url: 'https://jevstation.com/api/v1/systemone',
    model: 'jev-1.13.0',
    timeoutMs: 8000,
  });
  const tuned = jevConfig({
    JEV_API_KEY: 'k',
    FRIDAY_JEV_URL: 'https://api.typesafe.ai/v1/systemone',
    FRIDAY_JEV_MODEL: 'jev-x',
    FRIDAY_JEV_TIMEOUT_S: '2.5',
  });
  assert.deepEqual(tuned, {
    key: 'k',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-x',
    timeoutMs: 2500,
  });
  assert.equal(jevConfig({ FRIDAY_JEV_TIMEOUT_S: 'abc' }).timeoutMs, 8000, 'unparsable falls back');
  assert.equal(jevConfig({ FRIDAY_JEV_TIMEOUT_S: '-1' }).timeoutMs, 8000, 'non-positive falls back');
});

test('jevDisabledReason says why Jev is unusable', () => {
  assert.equal(jevDisabledReason({ key: '', url: 'https://x' }), 'set JEV_API_KEY');
  assert.equal(jevDisabledReason({ key: 'k', url: 'http://x' }), 'FRIDAY_JEV_URL must be https, got http://x');
  assert.equal(jevDisabledReason({ key: 'k', url: 'https://x' }), '');
});

test('parseAnswers reads both the JevStation envelope and the bare TypeSafe body', () => {
  const answers = { intent: { choice: 'time' } };
  assert.deepEqual(parseAnswers({ data: { answers, model: 'jev-1.13.0', credits: { remaining: 45 } } }), {
    answers,
    model: 'jev-1.13.0',
    credits: 45,
  });
  assert.deepEqual(parseAnswers({ answers, model: 'm' }), { answers, model: 'm', credits: null });
  assert.throws(() => parseAnswers({ data: {} }), /no answers/);
});

test('errorDetail prefers the API detail message and trims it', async () => {
  assert.equal(await errorDetail(jsonResponse({ detail: { message: 'Out of credits' } }, 402)), 'Out of credits');
  assert.equal(await errorDetail(jsonResponse({ message: 'Nope' }, 400)), 'Nope');
  assert.equal(await errorDetail(new Response('<html>', { status: 500 })), '<html>');
});

test('askJev posts JSON with the bearer key and parses both envelopes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({ data: { model: 'jev-1.13.0', answers: { intent: { choice: 'time' } }, credits: { remaining: 45 } } });
  };
  const result = await askJev({
    url: 'https://jev.example/api/v1/systemone',
    key: 'sk_test',
    body: { model: 'm', questions: {} },
    timeoutMs: 1000,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://jev.example/api/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'm', questions: {} });
  assert.deepEqual(result, { answers: { intent: { choice: 'time' } }, model: 'jev-1.13.0', credits: 45 });

  const bare = await askJev({
    url: 'https://x',
    key: 'sk_test',
    body: {},
    timeoutMs: 1000,
    fetchImpl: async () => jsonResponse({ model: 'm', answers: { intent: { choice: 'agent' } } }),
  });
  assert.deepEqual(bare, { answers: { intent: { choice: 'agent' } }, model: 'm', credits: null });
});

test('askJev reports an HTTP error with the API detail message', async () => {
  const fetchImpl = async () => jsonResponse({ detail: { message: 'Out of credits' } }, 402);
  await assert.rejects(
    askJev({ url: 'https://x', key: 'k', body: {}, timeoutMs: 1000, fetchImpl }),
    /Jev 402: Out of credits/,
  );
});

test('askJev times out on its own', async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.rejects(askJev({ url: 'https://x', key: 'k', body: {}, timeoutMs: 20, fetchImpl }), /Jev timed out/);
});

test('an external abort rejects without being reported as a timeout', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const pending = askJev({
    url: 'https://x',
    key: 'k',
    body: {},
    signal: controller.signal,
    timeoutMs: 5000,
    fetchImpl,
  });
  controller.abort();
  await assert.rejects(pending, (err) => {
    assert.notEqual(err.message, 'Jev timed out');
    assert.equal(controller.signal.aborted, true);
    return true;
  });
});
