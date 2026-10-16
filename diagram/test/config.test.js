import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

test('defaults to claude-code on loopback without a token', () => {
  const config = loadConfig({});
  assert.equal(config.agent, 'claude-code');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8790);
  assert.equal(config.token, null);
  assert.equal(config.agentTimeoutMs, 180000);
  assert.ok(path.isAbsolute(config.dataDir));
  assert.ok(config.dataDir.endsWith(path.join('diagram', 'data')));
});

test('refuses a non-loopback host without a token', () => {
  assert.throws(() => loadConfig({ DIAGRAM_HOST: '0.0.0.0' }), /DIAGRAM_TOKEN/);
  assert.equal(loadConfig({ DIAGRAM_HOST: '0.0.0.0', DIAGRAM_TOKEN: 'secret-token-123' }).token, 'secret-token-123');
});

test('accepts ::1 and localhost as loopback', () => {
  assert.equal(loadConfig({ DIAGRAM_HOST: '::1' }).host, '::1');
  assert.equal(loadConfig({ DIAGRAM_HOST: 'localhost' }).host, 'localhost');
});

test('rejects an unknown agent and a bad port', () => {
  assert.throws(() => loadConfig({ DIAGRAM_AGENT: 'gpt' }), /DIAGRAM_AGENT/);
  assert.throws(() => loadConfig({ DIAGRAM_PORT: 'abc' }), /DIAGRAM_PORT/);
});

test('hermes settings fall back to the FRIDAY_AGENT_* variables', () => {
  const config = loadConfig({ DIAGRAM_AGENT: 'hermes', FRIDAY_AGENT_URL: 'https://h.example.com/', FRIDAY_AGENT_KEY: 'k' });
  assert.deepEqual(config.hermes, { url: 'https://h.example.com', key: 'k', model: 'hermes-agent' });
  const own = loadConfig({ DIAGRAM_HERMES_URL: 'http://127.0.0.1:8642', DIAGRAM_HERMES_KEY: 'x', DIAGRAM_HERMES_MODEL: 'm', FRIDAY_AGENT_URL: 'https://other' });
  assert.deepEqual(own.hermes, { url: 'http://127.0.0.1:8642', key: 'x', model: 'm' });
});

test('refuses a plain http Hermes URL with a key on a non-loopback host', () => {
  assert.throws(() => loadConfig({ DIAGRAM_HERMES_URL: 'http://hermes.example.com', DIAGRAM_HERMES_KEY: 'k' }), /DIAGRAM_HERMES_URL/);
  assert.equal(loadConfig({ DIAGRAM_HERMES_URL: 'http://127.0.0.1:8642', DIAGRAM_HERMES_KEY: 'k' }).hermes.url, 'http://127.0.0.1:8642');
  assert.equal(loadConfig({ DIAGRAM_HERMES_URL: 'http://[::1]:8642', DIAGRAM_HERMES_KEY: 'k' }).hermes.url, 'http://[::1]:8642');
  assert.equal(loadConfig({ DIAGRAM_HERMES_URL: 'http://localhost:8642', DIAGRAM_HERMES_KEY: 'k' }).hermes.url, 'http://localhost:8642');
  assert.equal(loadConfig({ DIAGRAM_HERMES_URL: 'https://hermes.example.com', DIAGRAM_HERMES_KEY: 'k' }).hermes.url, 'https://hermes.example.com');
  assert.equal(loadConfig({ DIAGRAM_HERMES_URL: 'http://hermes.example.com' }).hermes.url, 'http://hermes.example.com');
});

test('timeout and model are read from the environment', () => {
  const config = loadConfig({ DIAGRAM_AGENT_TIMEOUT_S: '30', DIAGRAM_CLAUDE_MODEL: 'sonnet' });
  assert.equal(config.agentTimeoutMs, 30000);
  assert.equal(config.claudeModel, 'sonnet');
});
