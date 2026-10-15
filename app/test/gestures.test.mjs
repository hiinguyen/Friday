import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { ACTIONS, GestureControl, idleMsFromEnv } = require('../src/gestures.js');

class FakeWorker extends EventEmitter {
  starts = 0;
  stops = 0;
  start() {
    this.starts += 1;
  }
  stop() {
    this.stops += 1;
    this.emit('down');
  }
}

function fakeHypr({ refuse = false } = {}) {
  const calls = [];
  return {
    calls,
    dispatch: async (args) => {
      calls.push(args);
      if (refuse) throw new Error('Hyprland refused "dispatch x": Invalid dispatcher');
    },
    activeWorkspace: async () => ({ id: 3, name: '3', monitor: 'eDP-2' }),
  };
}

// One pending timer at a time is all GestureControl uses; fire() runs it.
function manualTimers() {
  const timers = {
    pending: null,
    setTimeout(fn, ms) {
      timers.pending = { fn, ms };
      return timers.pending;
    },
    clearTimeout(handle) {
      if (timers.pending === handle) timers.pending = null;
    },
    fire() {
      const { fn } = timers.pending;
      timers.pending = null;
      fn();
    },
  };
  return timers;
}

function setup(options = {}) {
  const worker = new FakeWorker();
  const hypr = fakeHypr(options);
  const timers = manualTimers();
  const order = [];
  const gestures = new GestureControl({
    worker,
    hypr,
    timers,
    idleMs: 20000,
    beforeAction: async () => order.push('beforeAction'),
  });
  const states = [];
  const actions = [];
  const errors = [];
  gestures.on('state', (state) => states.push(state));
  gestures.on('action', (action) => actions.push(action));
  gestures.on('error', (message) => errors.push(message));
  return { worker, hypr, timers, order, gestures, states, actions, errors };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('enabling starts the tracker once and reports starting, then on', () => {
  const { worker, gestures, states } = setup();
  assert.equal(gestures.enable(), true);
  assert.equal(gestures.enable(), false);
  worker.emit('ready');
  assert.equal(worker.starts, 1);
  assert.deepEqual(
    states.map((s) => s.mode),
    ['starting', 'on'],
  );
});

test('disabling stops the tracker and turns the badge off', () => {
  const { worker, gestures, states } = setup();
  gestures.enable();
  assert.equal(gestures.disable(), true);
  assert.equal(gestures.disable(), false);
  assert.equal(worker.stops, 1);
  assert.equal(gestures.enabled, false);
  assert.deepEqual(states.at(-1), { mode: 'off', pose: 'none', workspace: null, reason: 'off' });
});

test('toggle flips the mode', () => {
  const { gestures } = setup();
  gestures.toggle();
  assert.equal(gestures.enabled, true);
  gestures.toggle();
  assert.equal(gestures.enabled, false);
});

test('every swipe runs its dispatcher', async () => {
  for (const [key, action] of Object.entries(ACTIONS)) {
    const [pose, direction] = key.split(':');
    const { worker, hypr, gestures, actions } = setup();
    gestures.enable();
    worker.emit('gesture', { pose, direction });
    await settle();
    assert.deepEqual(hypr.calls, [action]);
    assert.deepEqual(actions, [{ pose, direction, action }]);
  }
});

test('an open-hand swipe right goes to the next workspace and reports it', async () => {
  const { worker, hypr, order, gestures, states } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('gesture', { pose: 'open', direction: 'right' });
  await settle();
  assert.deepEqual(hypr.calls, ['workspace e+1']);
  assert.deepEqual(order, ['beforeAction']);
  assert.equal(states.at(-1).workspace, '3');
});

test('swipes are ignored while gesture mode is off, and poses without an action always', async () => {
  const { worker, hypr, gestures } = setup();
  worker.emit('gesture', { pose: 'open', direction: 'right' });
  gestures.enable();
  worker.emit('gesture', { pose: 'other', direction: 'left' });
  await settle();
  assert.deepEqual(hypr.calls, []);
});

test('a refused dispatch is reported, not thrown', async () => {
  const { worker, gestures, actions, errors } = setup({ refuse: true });
  gestures.enable();
  worker.emit('gesture', { pose: 'fist', direction: 'left' });
  await settle();
  assert.deepEqual(actions, []);
  assert.match(errors[0], /gesture fist left: .*Invalid dispatcher/);
});

test('no hand in view for the idle time turns gesture mode off', () => {
  const { worker, timers, gestures, states } = setup();
  gestures.enable();
  worker.emit('ready');
  assert.equal(timers.pending.ms, 20000);
  timers.fire();
  assert.equal(gestures.enabled, false);
  assert.equal(worker.stops, 1);
  assert.equal(states.at(-1).reason, 'idle');
});

test('a hand held still in view keeps gesture mode on', () => {
  const { worker, timers, gestures } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('hand', 'open');
  timers.fire();
  assert.equal(gestures.enabled, true);
  assert.notEqual(timers.pending, null);
});

test('a tracker that reports ready after gesture mode ended does not turn it back on', () => {
  const { worker, gestures } = setup();
  gestures.enable();
  gestures.disable();
  worker.emit('ready');
  worker.emit('hand', 'open');
  assert.equal(gestures.enabled, false);
  assert.equal(gestures.state.mode, 'off');
});

test('a tracker crash while on shows the camera starting again', () => {
  const { worker, gestures } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('down');
  assert.equal(gestures.state.mode, 'starting');
});

test('the idle time comes from FRIDAY_GESTURE_IDLE_S', () => {
  assert.equal(idleMsFromEnv({ FRIDAY_GESTURE_IDLE_S: '5' }), 5000);
  assert.equal(idleMsFromEnv({ FRIDAY_GESTURE_IDLE_S: 'soon' }), 20000);
  assert.equal(idleMsFromEnv({}), 20000);
});
