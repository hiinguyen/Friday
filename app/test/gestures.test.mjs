import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { DISPATCHERS, GestureControl, SWIPES, idleMsFromEnv } = require('../src/gestures.js');

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

// Hyprland on workspace `current`; a dispatch lands on the workspace it names.
function fakeHypr({ current = 1, refuse = false } = {}) {
  const hypr = {
    current,
    calls: [],
    dispatch: async (args) => {
      hypr.calls.push(args);
      if (refuse) throw new Error('Hyprland refused "dispatch x": Invalid dispatcher');
      if (args.startsWith('workspace') || args.startsWith('movetoworkspace')) hypr.current = Number(args.split(' ').at(-1));
    },
    activeWorkspace: async () => ({ id: hypr.current, name: String(hypr.current), monitor: 'eDP-2' }),
    keywords: [],
    keyword: async (name, value) => {
      hypr.keywords.push(`${name} ${value}`);
      if (refuse) throw new Error(`Hyprland refused "keyword ${name} ${value}": no`);
    },
  };
  return hypr;
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
  assert.deepEqual(states.at(-1), {
    mode: 'off',
    fingers: null,
    carrying: false,
    zooming: false,
    pinched: false,
    zoom: 1,
    workspace: null,
    reason: 'off',
  });
});

test('toggle flips the mode', () => {
  const { gestures } = setup();
  gestures.toggle();
  assert.equal(gestures.enabled, true);
  gestures.toggle();
  assert.equal(gestures.enabled, false);
});

test('switching goes to the workspace and reports where it landed', async () => {
  const { worker, hypr, order, gestures, states, actions } = setup({ current: 1 });
  gestures.enable();
  worker.emit('ready');
  worker.emit('gesture', { action: 'switch', workspace: 3 });
  await settle();
  assert.deepEqual(hypr.calls, ['workspace 3']);
  assert.deepEqual(order, ['beforeAction']);
  assert.deepEqual(actions, [{ action: 'switch', workspace: 3, dispatcher: 'workspace 3' }]);
  assert.equal(states.at(-1).workspace, '3');
});

test('carrying moves the focused window and follows it', async () => {
  const { worker, hypr, gestures, actions } = setup({ current: 1 });
  gestures.enable();
  worker.emit('gesture', { action: 'carry', workspace: 4 });
  await settle();
  assert.deepEqual(hypr.calls, ['movetoworkspace 4']);
  assert.deepEqual(actions, [{ action: 'carry', workspace: 4, dispatcher: 'movetoworkspace 4' }]);
});

test('the workspace you are already on is left alone, so back-and-forth does not bounce', async () => {
  for (const action of Object.keys(DISPATCHERS)) {
    const { worker, hypr, order, gestures, states, actions } = setup({ current: 2 });
    gestures.enable();
    worker.emit('gesture', { action, workspace: 2 });
    await settle();
    assert.deepEqual(hypr.calls, []);
    assert.deepEqual(order, []);
    assert.deepEqual(actions, []);
    assert.equal(states.at(-1).workspace, '2');
  }
});

test('gestures are ignored while gesture mode is off, and unknown actions always', async () => {
  const { worker, hypr, gestures } = setup();
  worker.emit('gesture', { action: 'switch', workspace: 3 });
  gestures.enable();
  worker.emit('gesture', { action: 'close', workspace: 3 });
  await settle();
  assert.deepEqual(hypr.calls, []);
});

test('a refused dispatch is reported, not thrown', async () => {
  const { worker, gestures, actions, errors } = setup({ refuse: true });
  gestures.enable();
  worker.emit('gesture', { action: 'carry', workspace: 2 });
  await settle();
  assert.deepEqual(actions, []);
  assert.match(errors[0], /gesture carry 2: .*Invalid dispatcher/);
});

test('the hand count and the grab reach the badge', () => {
  const { worker, gestures, states } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('hand', { fingers: 0, carrying: true, zooming: false, pinched: false });
  assert.deepEqual(states.at(-1), {
    mode: 'on',
    fingers: 0,
    carrying: true,
    zooming: false,
    pinched: false,
    zoom: 1,
    workspace: null,
    reason: undefined,
  });
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
  worker.emit('hand', { fingers: 2, carrying: false });
  timers.fire();
  assert.equal(gestures.enabled, true);
  assert.notEqual(timers.pending, null);
});

test('a tracker that reports ready after gesture mode ended does not turn it back on', () => {
  const { worker, gestures } = setup();
  gestures.enable();
  gestures.disable();
  worker.emit('ready');
  worker.emit('hand', { fingers: 5, carrying: false });
  assert.equal(gestures.enabled, false);
  assert.equal(gestures.state.mode, 'off');
});

test('a tracker crash while on shows the camera starting again', () => {
  const { worker, gestures } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('hand', { fingers: 0, carrying: true });
  worker.emit('down');
  assert.equal(gestures.state.mode, 'starting');
  assert.equal(gestures.state.carrying, false);
});

test('the idle time comes from FRIDAY_GESTURE_IDLE_S', () => {
  assert.equal(idleMsFromEnv({ FRIDAY_GESTURE_IDLE_S: '5' }), 5000);
  assert.equal(idleMsFromEnv({ FRIDAY_GESTURE_IDLE_S: 'soon' }), 20000);
  assert.equal(idleMsFromEnv({}), 20000);
});

test('a zoom sets the screen zoom and reaches the badge', async () => {
  const { worker, hypr, gestures, states } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('hand', { fingers: 2, carrying: false, zooming: true });
  worker.emit('zoom', { factor: 1.5 });
  await settle();
  assert.deepEqual(hypr.keywords, ['cursor:zoom_factor 1.5']);
  assert.equal(states.at(-1).zoom, 1.5);
  assert.equal(states.at(-1).zooming, true);
});

test('zooms that arrive while one is being set collapse into the latest', async () => {
  const { worker, hypr, gestures, states } = setup();
  gestures.enable();
  for (const factor of [1.2, 1.4, 1.6, 1.8]) worker.emit('zoom', { factor });
  await settle();
  await settle();
  assert.deepEqual(hypr.keywords, ['cursor:zoom_factor 1.2', 'cursor:zoom_factor 1.8']);
  assert.equal(states.at(-1).zoom, 1.8);
});

test('turning gesture mode off zooms back out', async () => {
  const { worker, hypr, gestures, states } = setup();
  gestures.enable();
  worker.emit('zoom', { factor: 2 });
  await settle();
  gestures.disable();
  await settle();
  assert.deepEqual(hypr.keywords, ['cursor:zoom_factor 2', 'cursor:zoom_factor 1']);
  assert.equal(states.at(-1).mode, 'off');
  assert.equal(states.at(-1).zoom, 1);
});

test('zooms are ignored while gesture mode is off', async () => {
  const { worker, hypr } = setup();
  worker.emit('zoom', { factor: 2 });
  await settle();
  assert.deepEqual(hypr.keywords, []);
});

test('a zoomed-in screen keeps gesture mode on with no hand in view', async () => {
  const { worker, timers, gestures } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('zoom', { factor: 2 });
  await settle();
  worker.emit('hand', { fingers: null, carrying: false, zooming: false });
  timers.fire();
  assert.equal(gestures.enabled, true);
});

test('a restarted tracker starts from no zoom, so the screen zooms back out', async () => {
  const { worker, hypr, gestures } = setup();
  gestures.enable();
  worker.emit('ready');
  worker.emit('zoom', { factor: 2 });
  await settle();
  worker.emit('down');
  worker.emit('ready');
  await settle();
  assert.deepEqual(hypr.keywords, ['cursor:zoom_factor 2', 'cursor:zoom_factor 1']);
});

test('a refused zoom is reported, not thrown', async () => {
  const { worker, gestures, errors } = setup({ refuse: true });
  gestures.enable();
  worker.emit('zoom', { factor: 2 });
  await settle();
  assert.match(errors[0], /zoom 2: .*refused/);
  assert.equal(gestures.state.zoom, 1);
});

test('a swipe sends the browser its key, like a phone: up reads on, right goes back', async () => {
  const sent = {};
  for (const direction of ['up', 'down', 'left', 'right']) {
    const { worker, hypr, order, gestures, actions } = setup();
    gestures.enable();
    worker.emit('swipe', { direction });
    await settle();
    assert.deepEqual(order, ['beforeAction']);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].direction, direction);
    sent[direction] = hypr.calls[0];
  }
  assert.deepEqual(sent, {
    up: 'sendshortcut , Page_Down, activewindow',
    down: 'sendshortcut , Page_Up, activewindow',
    left: 'sendshortcut ALT, Right, activewindow',
    right: 'sendshortcut ALT, Left, activewindow',
  });
  assert.deepEqual(Object.keys(SWIPES).sort(), ['down', 'left', 'right', 'up']);
});

test('swipes are ignored while gesture mode is off, and unknown directions always', async () => {
  const { worker, hypr, gestures } = setup();
  worker.emit('swipe', { direction: 'up' });
  gestures.enable();
  worker.emit('swipe', { direction: 'around' });
  await settle();
  assert.deepEqual(hypr.calls, []);
});

test('a refused swipe is reported, not thrown', async () => {
  const { worker, gestures, errors } = setup({ refuse: true });
  gestures.enable();
  worker.emit('swipe', { direction: 'right' });
  await settle();
  assert.match(errors[0], /gesture swipe right: .*Invalid dispatcher/);
});

test('a pinch reaches the badge', () => {
  const { worker, gestures } = setup();
  gestures.enable();
  worker.emit('hand', { fingers: 3, carrying: false, zooming: false, pinched: true });
  assert.equal(gestures.state.pinched, true);
});
