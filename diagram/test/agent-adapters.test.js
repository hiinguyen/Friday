import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeCodeAdapter } from '../server/agent/claude-code.js';
import { createHermesAdapter } from '../server/agent/hermes.js';

function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (signal) => { child.killed = true; setImmediate(() => child.emit('close', null, signal)); return true; };
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk; });
    calls.push({ cmd, args, options, input: () => input });
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
  return { spawnImpl, calls };
}

const SCHEMA = { type: 'object' };

test('claude-code builds an isolated, tool-less command and reads structured_output', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { ok: 1 } }) });
  const adapter = createClaudeCodeAdapter({ model: 'sonnet', spawnImpl });
  const out = await adapter.run({ task: 'segment', system: 'SYS', user: 'USER', schema: SCHEMA, signal: new AbortController().signal });
  assert.deepEqual(out, { ok: 1 });
  const { cmd, args, options, input } = calls[0];
  assert.equal(cmd, 'claude');
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'SYS');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(SCHEMA));
  assert.ok(options.cwd.includes('diagram-agent-'));
  assert.equal(input(), 'USER');
});

test('claude-code falls back to the result text and maps errors', async () => {
  const text = fakeSpawn({ stdout: JSON.stringify({ type: 'result', is_error: false, result: 'Đây {"a":2}' }) });
  assert.deepEqual(await createClaudeCodeAdapter({ spawnImpl: text.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }), { a: 2 });
  const failed = fakeSpawn({ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached' }) });
  await assert.rejects(
    createClaudeCodeAdapter({ spawnImpl: failed.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }),
    { code: 'agent_error', message: 'AI báo lỗi.', detail: 'Usage limit reached' },
  );
  const missing = fakeSpawn({ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(createClaudeCodeAdapter({ spawnImpl: missing.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }), { code: 'agent_unavailable' });
  const crashed = fakeSpawn({ code: 2, stderr: 'boom' });
  await assert.rejects(createClaudeCodeAdapter({ spawnImpl: crashed.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }), { code: 'agent_error' });
});

test('claude-code never puts model output in the client message', async () => {
  const failed = fakeSpawn({ stdout: JSON.stringify({ type: 'result', is_error: true, result: 'SECRET-LIMIT-TEXT' }) });
  const error = await createClaudeCodeAdapter({ spawnImpl: failed.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }).then(() => null, (e) => e);
  assert.equal(error.message, 'AI báo lỗi.');
  assert.ok(!error.message.includes('SECRET-LIMIT-TEXT'));
  assert.equal(error.detail, 'SECRET-LIMIT-TEXT');
});

test('claude-code caps the collected output at 5 MB per stream', async () => {
  const big = fakeSpawn({ stdout: 'x'.repeat(6 * 1024 * 1024) });
  await assert.rejects(
    createClaudeCodeAdapter({ spawnImpl: big.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }),
    { code: 'agent_failed' },
  );
  const noisy = fakeSpawn({ code: 2, stderr: 'y'.repeat(6 * 1024 * 1024) });
  await assert.rejects(
    createClaudeCodeAdapter({ spawnImpl: noisy.spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }),
    { code: 'agent_failed' },
  );
});

test('claude-code spawns with a minimal environment', async () => {
  const saved = new Map();
  const set = (name, value) => { saved.set(name, process.env[name]); process.env[name] = value; };
  set('DIAGRAM_TOKEN', 'token-secret');
  set('DIAGRAM_HERMES_KEY', 'hermes-secret');
  set('ANTHROPIC_API_KEY', 'anthropic-key');
  set('CLAUDE_CONFIG_DIR', '/tmp/claude-config');
  try {
    const { spawnImpl, calls } = fakeSpawn({ stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: { ok: 1 } }) });
    await createClaudeCodeAdapter({ spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal });
    const env = calls[0].options.env;
    assert.ok(env && typeof env === 'object');
    assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-key');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/claude-config');
    if (process.env.PATH) assert.equal(env.PATH, process.env.PATH);
    if (process.env.HOME) assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.DIAGRAM_TOKEN, undefined);
    assert.equal(env.DIAGRAM_HERMES_KEY, undefined);
    for (const name of Object.keys(env)) {
      assert.ok(['PATH', 'HOME', 'LANG'].includes(name) || /^(ANTHROPIC_|CLAUDE_)/.test(name), `unexpected env ${name}`);
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});


test('claude-code kills the process when aborted', async () => {
  const { spawnImpl } = fakeSpawn({ hang: true });
  const controller = new AbortController();
  const pending = createClaudeCodeAdapter({ spawnImpl }).run({ system: '', user: '', schema: SCHEMA, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { code: 'cancelled' });
});

test('hermes posts an OpenAI-style request and parses the reply', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"x":1}\n```' } }] }), { status: 200 });
  };
  const adapter = createHermesAdapter({ url: 'https://h.example', key: 'k', model: 'hermes-agent', fetchImpl });
  assert.deepEqual(await adapter.run({ system: 'S', user: 'U', schema: SCHEMA, signal: new AbortController().signal }), { x: 1 });
  assert.equal(seen.url, 'https://h.example/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.stream, false);
  assert.ok(body.messages[0].content.startsWith('S'));
  assert.equal(body.messages[1].content, 'U');
});

test('hermes maps HTTP errors and missing settings', async () => {
  const fetchImpl = async () => new Response('nope', { status: 500 });
  await assert.rejects(createHermesAdapter({ url: 'https://h', key: 'k', model: 'm', fetchImpl }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }), { code: 'agent_error' });
  await assert.rejects(createHermesAdapter({ url: null, key: null, model: 'm' }).run({ system: '', user: '', schema: SCHEMA, signal: new AbortController().signal }), { code: 'agent_unavailable' });
});
