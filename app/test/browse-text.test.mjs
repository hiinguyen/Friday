import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { fieldContext, fieldText, textConfig, textDisabledReason, TextConfigError } = require('../src/browse/text.js');
const { TEXT_VALUE } = require('../src/browse/questions.js');

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatReply = (content) => jsonResponse({ choices: [{ message: { content } }] });
const config = (overrides = {}) => ({ url: 'https://api.openai.com/v1', key: 'sk_text', model: 'gpt-test', extra: {}, warning: '', ...overrides });

test('textConfig reads the endpoint, drops a trailing slash, and never defaults', () => {
  assert.deepEqual(textConfig({}), { url: '', key: '', model: '', extra: {}, warning: '' });
  const tuned = textConfig({
    FRIDAY_BROWSE_TEXT_URL: 'https://api.deepseek.com/v1/',
    FRIDAY_BROWSE_TEXT_KEY: 'k',
    FRIDAY_BROWSE_TEXT_MODEL: 'm',
    FRIDAY_BROWSE_TEXT_EXTRA: '{"temperature":0.2}',
  });
  assert.equal(tuned.url, 'https://api.deepseek.com/v1');
  assert.equal(tuned.key, 'k');
  assert.equal(tuned.model, 'm');
  assert.deepEqual(tuned.extra, { temperature: 0.2 });
  assert.equal(tuned.warning, '');
});

test('textConfig drops extras that would override the request shape', () => {
  const tuned = textConfig({
    FRIDAY_BROWSE_TEXT_EXTRA: '{"model":"evil","messages":[],"response_format":{},"temperature":0.1}',
  });
  assert.deepEqual(tuned.extra, { temperature: 0.1 });
});

test('textConfig ignores an extra that is not a JSON object', () => {
  for (const raw of ['nope', '[1,2]', '"text"', 'null']) {
    const tuned = textConfig({ FRIDAY_BROWSE_TEXT_EXTRA: raw });
    assert.deepEqual(tuned.extra, {}, raw);
    assert.equal(tuned.warning, 'FRIDAY_BROWSE_TEXT_EXTRA is not a JSON object, ignored', raw);
  }
});

test('textDisabledReason names what is missing, or an insecure URL', () => {
  assert.equal(textDisabledReason(config({ key: '' })), 'set FRIDAY_BROWSE_TEXT_URL, FRIDAY_BROWSE_TEXT_KEY and FRIDAY_BROWSE_TEXT_MODEL');
  assert.equal(textDisabledReason(config({ url: 'http://api.example/v1' })), 'FRIDAY_BROWSE_TEXT_URL must be https');
  assert.equal(textDisabledReason(config()), '');
});

test('fieldContext caps the page text and keeps the last six actions', () => {
  const history = Array.from({ length: 8 }, (_v, i) => ({ action: `a${i}`, text: `t${i}` }));
  const context = fieldContext('Find a book', { label: 'City', role: 'textbox', value: 'Zurich' }, { title: 'T', text: 'x'.repeat(7000) }, history);
  assert.equal(context.goal, 'Find a book');
  assert.deepEqual(context.field, { label: 'City', role: 'textbox', value: 'Zurich' });
  assert.equal(context.page.text.length, 6000);
  assert.deepEqual(context.recent_actions.map((a) => a.action), ['a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
});

test('fieldText posts the one request an OpenAI-compatible endpoint expects', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return chatReply('{"text":"London"}');
  };
  const context = { goal: 'Find a book' };
  const result = await fieldText(context, { config: config(), fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_text');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.max_tokens, 1024);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, TEXT_VALUE);
  assert.equal(body.messages[1].content, JSON.stringify(context));
  assert.equal(result.text, 'London');
  assert.equal(result.model, 'gpt-test');
  assert.ok(Number.isInteger(result.ms) && result.ms >= 0);
});

test('provider-specific extras merge in but cannot override the model', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return chatReply('{"text":"a"}');
  };
  const tuned = textConfig({
    FRIDAY_BROWSE_TEXT_URL: 'https://api.deepseek.com/v1',
    FRIDAY_BROWSE_TEXT_KEY: 'k',
    FRIDAY_BROWSE_TEXT_MODEL: 'deepseek-chat',
    FRIDAY_BROWSE_TEXT_EXTRA: '{"model":"evil","thinking":{"type":"disabled"}}',
  });
  await fieldText({}, { config: tuned, fetchImpl });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.deepEqual(body.thinking, { type: 'disabled' });
});

test('fieldText rejects a reply that is not exactly one valid text value', async () => {
  const bad = [
    '{"text":null}',
    '{"text":""}',
    '{"text":"a","x":1}',
    'not json',
    `{"text":"${'a'.repeat(2001)}"}`,
    '"a"',
    '{"other":"a"}',
  ];
  for (const content of bad) {
    await assert.rejects(
      fieldText({}, { config: config(), fetchImpl: async () => chatReply(content) }),
      /Text helper returned no valid field value; nothing typed\./,
      content.slice(0, 40),
    );
  }
});

test('a missing text model stops before any fetch', async () => {
  let called = false;
  await assert.rejects(
    fieldText({}, { config: textConfig({}), fetchImpl: async () => {
      called = true;
      return chatReply('{"text":"x"}');
    } }),
    (err) => {
      assert.ok(err instanceof TextConfigError);
      assert.match(err.message, /^TYPE_TEXT needs a text model: /);
      return true;
    },
  );
  assert.equal(called, false, 'the endpoint was never called');
});

test('a plain-http endpoint is refused before any fetch', async () => {
  let called = false;
  await assert.rejects(
    fieldText({}, { config: config({ url: 'http://api.example/v1' }), fetchImpl: async () => {
      called = true;
      return chatReply('{"text":"x"}');
    } }),
    TextConfigError,
  );
  assert.equal(called, false);
});

test('a throttled request is retried, and the retry is used', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 429) : chatReply('{"text":"ok"}');
  };
  const result = await fieldText({}, { config: config(), fetchImpl });
  assert.equal(calls, 2);
  assert.equal(result.text, 'ok');
});

test('a server error fails at once without echoing the body', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ detail: 'a secret the caller must not see' }, 500);
  };
  await assert.rejects(fieldText({}, { config: config(), fetchImpl }), (err) => {
    assert.match(err.message, /Text model 500/);
    assert.ok(!err.message.includes('secret'), 'the response body is not echoed');
    return true;
  });
  assert.equal(calls, 1);
});
