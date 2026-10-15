'use strict';

// The gesture-mode badge, pinned to the top-right corner: shows that the
// camera is on, how many fingers it sees or that a window is grabbed, and
// flashes the workspace each command went to.

const { GestureOverlay } = require('./overlay');

const BADGE_TITLE = 'F.R.I.D.A.Y. gesture';

class Badge extends GestureOverlay {
  constructor() {
    super({ title: BADGE_TITLE, width: 220, height: 56, page: 'badge.html', stateChannel: 'badge:state' });
  }

  action(action) {
    this.send('badge:action', action);
  }
}

module.exports = { BADGE_TITLE, Badge };
