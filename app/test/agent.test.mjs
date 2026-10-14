import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { HermesAgent, REPLY_LANGUAGE_NOTE, createSseParser, toolLabel } = require('../src/agent.js');

// A Response whose body is the given SSE text, delivered in the given chunks.
function sseResponse(chunks, init = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

function collect(agent) {
  const events = [];
  for (const name of ['start', 'delta', 'tool', 'done', 'error']) {
    agent.on(name, (payload) => events.push({ name, ...payload }));
  }
  return events;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the SSE parser reassembles events across chunk boundaries and drops keepalives', () => {
  const events = [];
  const feed = createSseParser((name, data) => events.push([name, data]));
  feed('data: {"a":1}\n');
  feed('\n: keepalive\n');
  feed('event: hermes.tool.progress\ndata: {"tool":');
  feed('"read_file"}\n\n');
  feed('data: [DONE]\n\n');
  assert.deepEqual(events, [
    ['message', '{"a":1}'],
    ['hermes.tool.progress', '{"tool":"read_file"}'],
    ['message', '[DONE]'],
  ]);
});

test('toolLabel reads a name from JSON and falls back to the raw payload', () => {
  assert.equal(toolLabel('{"tool":"read_file"}'), 'read_file');
  assert.equal(toolLabel('{"name":"web_search"}'), 'web_search');
  assert.equal(toolLabel('running terminal'), 'running terminal');
  assert.equal(toolLabel(''), 'tool');
});

test('the bridge is disabled without a URL or key, so ask() does nothing', async () => {
  for (const options of [{ baseUrl: '', key: '' }, { baseUrl: 'http://x', key: '' }, { baseUrl: '', key: 'k' }]) {
    const agent = new HermesAgent({ ...options, fetchImpl: () => assert.fail('fetch must not run') });
    assert.equal(agent.enabled, false);
    await agent.ask(1, 'hello');
  }
});

test('a streamed reply becomes delta, tool and a final done with the full text', async () => {
  const url = 'http://hermes.test:8642/v1/chat/completions';
  let seen;
  const agent = new HermesAgent({
    baseUrl: 'http://hermes.test:8642/',
    key: 'secret',
    session: 'friday',
    fetchImpl: (called, init) => {
      seen = { called, init };
      return Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
          '\n: keepalive\nevent: hermes.tool.pro',
          'gress\ndata: {"tool":"read_file"}\n\ndata: {"cho',
          'ices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
        ]),
      );
    },
  });
  const events = collect(agent);
  await agent.ask(7, 'say hello');

  assert.equal(seen.called, url, 'trailing slash is trimmed and the path appended');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer secret');
  assert.equal(seen.init.headers['X-Hermes-Session-Id'], 'friday');
  assert.deepEqual(JSON.parse(seen.init.body), {
    model: 'hermes-agent',
    stream: true,
    messages: [{ role: 'user', content: `say hello\n\n${REPLY_LANGUAGE_NOTE}` }],
  });
  assert.deepEqual(events, [
    { name: 'start', id: 7 },
    { name: 'delta', id: 7, text: 'Hel' },
    { name: 'tool', id: 7, label: 'read_file' },
    { name: 'delta', id: 7, text: 'lo' },
    { name: 'done', id: 7, text: 'Hello' },
  ]);
});

test('an empty session omits the continuity header', async () => {
  let headers;
  const agent = new HermesAgent({
    baseUrl: 'http://h',
    key: 'k',
    session: '',
    fetchImpl: (_url, init) => {
      headers = init.headers;
      return Promise.resolve(sseResponse(['data: [DONE]\n\n']));
    },
  });
  await agent.ask(1, 'hi');
  assert.equal('X-Hermes-Session-Id' in headers, false);
});

test('a rejected request surfaces the status and body as an error', async () => {
  const agent = new HermesAgent({
    baseUrl: 'http://h',
    key: 'bad',
    fetchImpl: () => Promise.resolve(new Response('invalid token', { status: 401, statusText: 'Unauthorized' })),
  });
  const events = collect(agent);
  await agent.ask(3, 'hello');
  assert.deepEqual(events, [
    { name: 'start', id: 3 },
    { name: 'error', id: 3, message: 'Hermes 401: invalid token' },
  ]);
});

test('a newer command cancels the run in flight', async () => {
  const signals = [];
  const agent = new HermesAgent({
    baseUrl: 'http://h',
    key: 'k',
    timeoutSeconds: 0.05,
    fetchImpl: (_url, init) => {
      signals.push(init.signal);
      return new Promise(() => {}); // never settles: the run is abandoned
    },
  });
  agent.ask(1, 'first');
  await flush();
  agent.ask(2, 'second');
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, 'the first run is aborted');
  assert.equal(signals[1].aborted, false, 'the second run is live');
  agent.close();
});

test('a per-command session overrides the configured one', async () => {
  let headers;
  const agent = new HermesAgent({
    baseUrl: 'http://h',
    key: 'k',
    session: 'friday',
    fetchImpl: (_url, init) => {
      headers = init.headers;
      return Promise.resolve(sseResponse(['data: [DONE]\n\n']));
    },
  });
  await agent.ask(1, 'hi', 'friday-20261014-203105');
  assert.equal(headers['X-Hermes-Session-Id'], 'friday-20261014-203105');
  await agent.ask(2, 'hi', '');
  assert.equal('X-Hermes-Session-Id' in headers, false, 'an empty session is stateless');
});

test('the idle window comes from FRIDAY_AGENT_SESSION_IDLE_S, defaulting to ten minutes', () => {
  assert.equal(new HermesAgent({ baseUrl: '', key: '' }).sessionIdleMs, 600_000);
  assert.equal(new HermesAgent({ baseUrl: '', key: '', sessionIdleSeconds: '90' }).sessionIdleMs, 90_000);
  assert.equal(new HermesAgent({ baseUrl: '', key: '', sessionIdleSeconds: 'nope' }).sessionIdleMs, 600_000);
});
