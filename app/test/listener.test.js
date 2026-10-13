'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WakeListener } = require('../src/listener');

function collect(listener) {
  const events = [];
  for (const name of ['ready', 'wake', 'level', 'error', 'capture', 'transcript']) {
    listener.on(name, (payload) => events.push([name, payload]));
  }
  return events;
}

test('translates listener JSON lines into typed events', () => {
  const listener = new WakeListener();
  const events = collect(listener);
  listener.handleLine('{"type": "ready", "voiceprint": "armed"}');
  listener.handleLine('{"type": "wake", "conf": 0.93}');
  listener.handleLine('{"type": "level", "value": 0.25}');
  listener.handleLine('{"type": "error", "message": "mic gone"}');
  assert.deepEqual(events, [
    ['ready', { voiceprint: 'armed' }],
    ['wake', 0.93],
    ['level', 0.25],
    ['error', 'mic gone'],
  ]);
});

test('a ready event names the voiceprint state, defaulting to off', () => {
  const listener = new WakeListener();
  const events = collect(listener);
  listener.handleLine('{"type": "ready", "voiceprint": "unusable"}');
  listener.handleLine('{"type": "ready"}');
  listener.handleLine('{"type": "ready", "voiceprint": "bogus"}');
  assert.deepEqual(events, [
    ['ready', { voiceprint: 'unusable' }],
    ['ready', { voiceprint: 'off' }],
    ['ready', { voiceprint: 'off' }],
  ]);
});

test('forwards voice command events whole', () => {
  const listener = new WakeListener();
  const events = collect(listener);
  listener.handleLine('{"type": "capture", "id": 2, "state": "listening"}');
  listener.handleLine('{"type": "transcript", "id": 2, "delta": "open"}');
  assert.deepEqual(events, [
    ['capture', { type: 'capture', id: 2, state: 'listening' }],
    ['transcript', { type: 'transcript', id: 2, delta: 'open' }],
  ]);
});

test('ignores malformed and unknown lines instead of throwing', (t) => {
  t.mock.method(console, 'error', () => {});
  const listener = new WakeListener();
  const events = collect(listener);
  listener.handleLine('not json');
  listener.handleLine('{"type": "mystery"}');
  assert.deepEqual(events, []);
  assert.equal(console.error.mock.callCount(), 2);
});

test('keeps retrying when the listener binary cannot be spawned', async (t) => {
  t.mock.method(console, 'error', () => {});
  const original = process.env.FRIDAY_PYTHON;
  process.env.FRIDAY_PYTHON = '/nonexistent/python';
  delete require.cache[require.resolve('../src/listener')];
  const { WakeListener: Fresh } = require('../src/listener');
  const listener = new Fresh({ backoffMs: [5] });
  const errors = [];
  listener.on('error', (message) => errors.push(message));
  listener.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  listener.stop();
  if (original === undefined) delete process.env.FRIDAY_PYTHON;
  else process.env.FRIDAY_PYTHON = original;
  // Several attempts, and never two live children at once.
  assert.ok(errors.length >= 3, `only ${errors.length} attempts`);
  assert.ok(errors.every((m) => /cannot start listener|exited/.test(m)));
});
