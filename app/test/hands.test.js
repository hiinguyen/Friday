'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HandWorker } = require('../src/hands');

function collect(worker) {
  const events = [];
  for (const name of ['ready', 'hand', 'gesture', 'zoom', 'swipe', 'frame', 'error']) {
    worker.on(name, (payload) => events.push([name, payload]));
  }
  return events;
}

function quietly(fn) {
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logged;
}

test('translates hand tracker JSON lines into typed events', () => {
  const worker = new HandWorker();
  const events = collect(worker);
  worker.handleLine('{"type": "ready"}');
  worker.handleLine('{"type": "hand", "fingers": 3, "carrying": false, "zooming": false, "pinched": true}');
  worker.handleLine('{"type": "hand", "fingers": null, "carrying": false, "zooming": true, "pinched": false}');
  worker.handleLine('{"type": "gesture", "action": "carry", "workspace": 2}');
  worker.handleLine('{"type": "zoom", "factor": 1.75}');
  worker.handleLine('{"type": "swipe", "direction": "left"}');
  worker.handleLine('{"type": "frame", "jpeg": "/9j/", "hands": [], "fingers": null, "carrying": false, "progress": 0}');
  worker.handleLine('{"type": "error", "message": "cannot open camera /dev/video0"}');
  assert.deepEqual(events, [
    ['ready', undefined],
    ['hand', { fingers: 3, carrying: false, zooming: false, pinched: true }],
    ['hand', { fingers: null, carrying: false, zooming: true, pinched: false }],
    ['gesture', { action: 'carry', workspace: 2 }],
    ['zoom', { factor: 1.75 }],
    ['swipe', { direction: 'left' }],
    ['frame', { type: 'frame', jpeg: '/9j/', hands: [], fingers: null, carrying: false, progress: 0 }],
    ['error', 'cannot open camera /dev/video0'],
  ]);
});

test('drops events with an impossible count, action, workspace, zoom or swipe', () => {
  const worker = new HandWorker();
  const events = collect(worker);
  const logged = quietly(() => {
    worker.handleLine('{"type": "hand", "fingers": 6, "carrying": false, "zooming": false, "pinched": false}');
    worker.handleLine('{"type": "hand", "fingers": 2, "carrying": false, "zooming": false}');
    worker.handleLine('{"type": "swipe", "direction": "sideways"}');
    worker.handleLine('{"type": "zoom", "factor": 0.5}');
    worker.handleLine('{"type": "zoom", "factor": "2"}');
    worker.handleLine('{"type": "gesture", "action": "close", "workspace": 2}');
    worker.handleLine('{"type": "gesture", "action": "switch", "workspace": 0}');
    worker.handleLine('{"type": "frame", "landmarks": null}');
  });
  assert.deepEqual(events, []);
  assert.equal(logged.length, 8);
  assert.equal(logged[7], '[hands] debug frame without a picture');
});
