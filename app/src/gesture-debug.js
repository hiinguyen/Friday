'use strict';

// The gesture debug view (FRIDAY_GESTURE_DEBUG=1): what the camera sees while
// gesture mode is on, with the hand's skeleton, the finger count and how close
// it is to firing, pinned to the bottom-right corner. hands.py sends the
// frames only when the same setting is on.

const { GestureOverlay } = require('./overlay');

const DEBUG_TITLE = 'F.R.I.D.A.Y. gesture debug';

const debugFromEnv = (env = process.env) => env.FRIDAY_GESTURE_DEBUG === '1';

class GestureDebug extends GestureOverlay {
  constructor({ enabled = debugFromEnv() } = {}) {
    super({
      title: DEBUG_TITLE,
      width: 400,
      height: 340,
      page: 'gesture-debug.html',
      stateChannel: 'gesture-debug:state',
    });
    this.enabled = enabled;
  }

  create() {
    if (this.enabled) super.create();
  }

  frame(frame) {
    // About 15 a second: none while hidden.
    if (this.visible) this.send('gesture-debug:frame', frame);
  }
}

module.exports = { DEBUG_TITLE, GestureDebug, debugFromEnv };
