'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HandWorker } = require('../src/hands');

function collect(worker) {
  const events = [];
  for (const name of ['ready', 'hand', 'gesture', 'error']) {
    worker.on(name, (payload) => events.push([name, payload]));
  }
  return events;
}

test('translates hand tracker JSON lines into typed events', () => {
  const worker = new HandWorker();
  const events = collect(worker);
  worker.handleLine('{"type": "ready"}');
  worker.handleLine('{"type": "hand", "pose": "fist"}');
  worker.handleLine('{"type": "gesture", "pose": "open", "direction": "left"}');
  worker.handleLine('{"type": "error", "message": "cannot open camera /dev/video0"}');
  assert.deepEqual(events, [
    ['ready', undefined],
    ['hand', 'fist'],
    ['gesture', { pose: 'open', direction: 'left' }],
    ['error', 'cannot open camera /dev/video0'],
  ]);
});

test('drops events with an unknown pose or direction', () => {
  const worker = new HandWorker();
  const events = collect(worker);
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    worker.handleLine('{"type": "hand", "pose": "peace"}');
    worker.handleLine('{"type": "gesture", "pose": "open", "direction": "up"}');
  } finally {
    console.error = original;
  }
  assert.deepEqual(events, []);
  assert.equal(logged.length, 2);
});
