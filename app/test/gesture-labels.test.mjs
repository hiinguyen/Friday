import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HAND_CONNECTIONS, actionLabel, handLabel } from '../renderer/gesture/labels.js';

test('the label says what hand gesture mode sees', () => {
  assert.equal(handLabel({ mode: 'starting', fingers: null, carrying: false }), 'CAMERA');
  assert.equal(handLabel({ mode: 'on', fingers: null, carrying: false }), 'NO HAND');
  assert.equal(handLabel({ mode: 'on', fingers: 0, carrying: false }), 'FIST');
  assert.equal(handLabel({ mode: 'on', fingers: 1, carrying: false }), '1 FINGER');
  assert.equal(handLabel({ mode: 'on', fingers: 4, carrying: false }), '4 FINGERS');
});

test('a grabbed window shows until it is carried', () => {
  assert.equal(handLabel({ mode: 'on', fingers: 0, carrying: true }), 'GRABBED');
  assert.equal(handLabel({ mode: 'on', fingers: null, carrying: true }), 'GRABBED');
  assert.equal(handLabel({ mode: 'on', fingers: 3, carrying: true }), 'CARRY TO 3');
});

test('two hands zooming show the zoom', () => {
  assert.equal(handLabel({ mode: 'on', fingers: 2, carrying: false, zooming: true, zoom: 1 }), 'ZOOM 1.0×');
  assert.equal(handLabel({ mode: 'on', fingers: 2, carrying: false, zooming: true, zoom: 2.46 }), 'ZOOM 2.5×');
});

test('an action flashes the workspace it went to', () => {
  assert.equal(actionLabel({ action: 'switch', workspace: 2 }), '→ 2');
  assert.equal(actionLabel({ action: 'carry', workspace: 5 }), '→ 5');
});

test('a pinch shows, and a swipe flashes what it did to the page', () => {
  assert.equal(handLabel({ mode: 'on', fingers: 3, carrying: false, zooming: false, pinched: true }), 'PINCH');
  assert.equal(actionLabel({ action: 'swipe', direction: 'up' }), '↑ SCROLL');
  assert.equal(actionLabel({ action: 'swipe', direction: 'down' }), '↓ SCROLL');
  assert.equal(actionLabel({ action: 'swipe', direction: 'right' }), '→ BACK');
  assert.equal(actionLabel({ action: 'swipe', direction: 'left' }), '← FORWARD');
});

test('the skeleton joins all 21 landmarks', () => {
  const joined = new Set(HAND_CONNECTIONS.flat());
  assert.equal(joined.size, 21);
  assert.ok([...joined].every((i) => i >= 0 && i <= 20));
});
