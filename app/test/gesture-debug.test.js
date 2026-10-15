'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { GestureDebug, debugFromEnv } = require('../src/gesture-debug');

test('the debug view is on only with FRIDAY_GESTURE_DEBUG=1', () => {
  assert.equal(debugFromEnv({ FRIDAY_GESTURE_DEBUG: '1' }), true);
  assert.equal(debugFromEnv({ FRIDAY_GESTURE_DEBUG: '0' }), false);
  assert.equal(debugFromEnv({}), false);
});

test('a disabled debug view never opens a window', () => {
  const debug = new GestureDebug({ enabled: false });
  debug.create();
  assert.equal(debug.win, null);
});

test('frames are dropped while the view is not showing', () => {
  const debug = new GestureDebug({ enabled: true });
  const sent = [];
  debug.send = (channel, payload) => sent.push([channel, payload]);
  debug.frame({ type: 'frame', jpeg: '/9j/' });
  assert.deepEqual(sent, []);
});
