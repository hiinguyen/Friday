'use strict';

// Gesture mode: while it is on, the camera hand tracker (hands.js) runs and
// its swipes drive Hyprland (hypr.js). Voice ("Friday, turn on gesture
// control") and `friday gesture` turn it on. It turns itself off once no hand
// has been in view for FRIDAY_GESTURE_IDLE_S seconds (default 20), which stops
// the tracker and releases the camera.
//
//   open hand, swipe left/right   previous / next open workspace on this monitor
//   fist, swipe left/right        carry the focused window to the previous / next workspace

const { EventEmitter } = require('node:events');

const DEFAULT_IDLE_S = 20;
const ACTIONS = {
  'open:left': 'workspace e-1',
  'open:right': 'workspace e+1',
  'fist:left': 'movetoworkspace r-1',
  'fist:right': 'movetoworkspace r+1',
};

function idleMsFromEnv(env = process.env) {
  const seconds = Number.parseFloat(env.FRIDAY_GESTURE_IDLE_S);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_IDLE_S) * 1000;
}

// Events: 'state' with {mode: 'off' | 'starting' | 'on', pose, workspace, reason}
// for the badge, 'action' {pose, direction, action} after a dispatch went
// through, and 'error' with a message.
class GestureControl extends EventEmitter {
  /**
   * @param {object} options
   *   worker: a HandWorker; hypr: {dispatch, activeWorkspace} (hypr.js);
   *   beforeAction: awaited before each dispatch, so the HUD can get out of the way;
   *   idleMs and timers: for the tests.
   */
  constructor({
    worker,
    hypr,
    beforeAction = async () => {},
    idleMs = idleMsFromEnv(),
    timers = { setTimeout, clearTimeout },
  }) {
    super();
    Object.assign(this, { worker, hypr, beforeAction, idleMs, timers });
    this.state = { mode: 'off', pose: 'none', workspace: null };
    this.idleTimer = null;
    // Lines the tracker wrote just before it was stopped can still arrive: only act while on.
    worker.on('ready', () => {
      if (this.enabled) this.update({ mode: 'on' });
    });
    worker.on('hand', (pose) => {
      if (this.enabled) this.update({ pose });
    });
    worker.on('gesture', (gesture) => this.run(gesture));
    worker.on('down', () => {
      if (this.enabled) this.update({ mode: 'starting', pose: 'none' });
    });
    worker.on('error', (message) => this.emit('error', message));
  }

  get enabled() {
    return this.state.mode !== 'off';
  }

  enable() {
    this.armIdle();
    if (this.enabled) return false;
    this.update({ mode: 'starting', pose: 'none', reason: undefined });
    this.worker.start();
    return true;
  }

  disable(reason = 'off') {
    if (!this.enabled) return false;
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Off before stop(): stopping emits 'down', which must find the mode already off.
    this.update({ mode: 'off', pose: 'none', workspace: null, reason });
    this.worker.stop();
    return true;
  }

  toggle() {
    return this.enabled ? this.disable() : this.enable();
  }

  armIdle() {
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => this.onIdle(), this.idleMs);
  }

  onIdle() {
    this.idleTimer = null;
    // The tracker reports pose changes only: a hand held still is still in view.
    if (this.state.pose !== 'none') this.armIdle();
    else this.disable('idle');
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async run({ pose, direction }) {
    const action = ACTIONS[`${pose}:${direction}`];
    if (!this.enabled || !action) return;
    this.armIdle();
    try {
      await this.beforeAction();
      await this.hypr.dispatch(action);
      this.emit('action', { pose, direction, action });
      const workspace = await this.hypr.activeWorkspace();
      if (this.enabled) this.update({ workspace: workspace.name });
    } catch (err) {
      this.emit('error', `gesture ${pose} ${direction}: ${err.message}`);
    }
  }
}

module.exports = { ACTIONS, GestureControl, idleMsFromEnv };
