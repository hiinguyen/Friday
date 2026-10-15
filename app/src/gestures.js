'use strict';

// Gesture mode: while it is on, the camera hand tracker (hands.js) runs and
// its finger commands drive Hyprland (hypr.js). Voice ("Friday, turn on
// gesture control") and `friday gesture` turn it on. It turns itself off once
// no hand has been in view for FRIDAY_GESTURE_IDLE_S seconds (default 20),
// which stops the tracker and releases the camera.
//
//   1 to 5 fingers held up              go to workspace 1 to 5
//   a fist, then 1 to 5 fingers         carry the focused window there (and follow it)
//   both index fingers out, spread      zoom the screen in (together: out)
//   a pinch dragged up / down           scroll the focused window a page on / back
//   a pinch dragged right / left        back / forward (in a browser)
//
// Swipes go like a phone's: drag the page up to read on. They are keys sent
// to the focused window (Hyprland's sendshortcut), so they need nothing
// installed and work in any app that knows them.
//
// The zoom is Hyprland's cursor:zoom_factor. It keeps gesture mode on while
// the screen is zoomed in, and turning gesture mode off zooms back out.

const { EventEmitter } = require('node:events');

const DEFAULT_IDLE_S = 20;
const NO_ZOOM = 1;
const DISPATCHERS = {
  switch: (workspace) => `workspace ${workspace}`,
  carry: (workspace) => `movetoworkspace ${workspace}`,
};

const SWIPES = {
  up: 'sendshortcut , Page_Down, activewindow',
  down: 'sendshortcut , Page_Up, activewindow',
  left: 'sendshortcut ALT, Right, activewindow',
  right: 'sendshortcut ALT, Left, activewindow',
};

function idleMsFromEnv(env = process.env) {
  const seconds = Number.parseFloat(env.FRIDAY_GESTURE_IDLE_S);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_IDLE_S) * 1000;
}

// Events: 'state' with {mode: 'off' | 'starting' | 'on', fingers, carrying,
// zooming, zoom, pinched, workspace, reason} for the badge, 'action' {action,
// workspace or direction, dispatcher} after a dispatch went through, and
// 'error' with a message.
class GestureControl extends EventEmitter {
  /**
   * @param {object} options
   *   worker: a HandWorker; hypr: {dispatch, activeWorkspace, keyword} (hypr.js);
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
    this.state = {
      mode: 'off',
      fingers: null,
      carrying: false,
      zooming: false,
      pinched: false,
      zoom: NO_ZOOM,
      workspace: null,
    };
    this.idleTimer = null;
    this.zoomTarget = NO_ZOOM; // the zoom to set; state.zoom is the one Hyprland has
    this.zooming = false; // a zoom is being set
    // Lines the tracker wrote just before it was stopped can still arrive: only act while on.
    worker.on('ready', () => {
      if (!this.enabled) return;
      this.update({ mode: 'on' });
      // A new tracker starts from no zoom: match the screen to it.
      this.zoomTo(NO_ZOOM);
    });
    worker.on('hand', ({ fingers, carrying, zooming, pinched }) => {
      if (this.enabled) this.update({ fingers, carrying, zooming, pinched });
    });
    worker.on('gesture', (gesture) => this.run(gesture));
    worker.on('swipe', ({ direction }) => this.swipe(direction));
    worker.on('zoom', ({ factor }) => {
      if (!this.enabled) return;
      this.armIdle();
      this.zoomTo(factor);
    });
    worker.on('down', () => {
      if (this.enabled) this.update({ mode: 'starting', fingers: null, carrying: false, zooming: false, pinched: false });
    });
    worker.on('error', (message) => this.emit('error', message));
  }

  get enabled() {
    return this.state.mode !== 'off';
  }

  enable() {
    this.armIdle();
    if (this.enabled) return false;
    this.update({ mode: 'starting', fingers: null, carrying: false, zooming: false, pinched: false, reason: undefined });
    this.worker.start();
    return true;
  }

  disable(reason = 'off') {
    if (!this.enabled) return false;
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Off before stop(): stopping emits 'down', which must find the mode already off.
    this.update({ mode: 'off', fingers: null, carrying: false, zooming: false, pinched: false, workspace: null, reason });
    this.worker.stop();
    this.zoomTo(NO_ZOOM);
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
    // The tracker reports count changes only: a hand held still is still in view.
    // A zoomed-in screen stays on too: zooming back out needs the camera.
    if (this.state.fingers !== null || this.state.zoom !== NO_ZOOM) this.armIdle();
    else this.disable('idle');
  }

  async swipe(direction) {
    const dispatcher = SWIPES[direction];
    if (!this.enabled || !dispatcher) return;
    this.armIdle();
    try {
      await this.beforeAction();
      await this.hypr.dispatch(dispatcher);
      this.emit('action', { action: 'swipe', direction, dispatcher });
    } catch (err) {
      this.emit('error', `gesture swipe ${direction}: ${err.message}`);
    }
  }

  // Set the screen zoom. A zoom asked for while one is being set replaces any
  // other waiting one: the tracker sends them faster than Hyprland needs.
  zoomTo(factor) {
    this.zoomTarget = factor;
    if (!this.zooming) this.applyZoom();
  }

  async applyZoom() {
    this.zooming = true;
    let factor;
    try {
      while (this.zoomTarget !== this.state.zoom) {
        factor = this.zoomTarget;
        await this.hypr.keyword('cursor:zoom_factor', factor);
        this.update({ zoom: factor });
      }
    } catch (err) {
      this.zoomTarget = this.state.zoom;
      this.emit('error', `gesture zoom ${factor}: ${err.message}`);
    } finally {
      this.zooming = false;
    }
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async run({ action, workspace }) {
    const dispatcher = DISPATCHERS[action]?.(workspace);
    if (!this.enabled || !dispatcher) return;
    this.armIdle();
    try {
      // With binds:workspace_back_and_forth, going to the workspace you are
      // already on goes back to the previous one: there is nothing to do.
      const current = await this.hypr.activeWorkspace();
      if (current.id !== workspace) {
        await this.beforeAction();
        await this.hypr.dispatch(dispatcher);
        this.emit('action', { action, workspace, dispatcher });
      }
      const landed = current.id === workspace ? current : await this.hypr.activeWorkspace();
      if (this.enabled) this.update({ workspace: landed.name });
    } catch (err) {
      this.emit('error', `gesture ${action} ${workspace}: ${err.message}`);
    }
  }
}

module.exports = { DISPATCHERS, GestureControl, SWIPES, idleMsFromEnv };
