'use strict';

// The gesture-mode badge: a small click-through window that hypr/friday.conf
// pins to the top-right corner. It is never focusable, so a "carry the window"
// gesture always moves the owner's window, not the badge. It shows that the
// camera is on, the hand pose it sees, and flashes each workspace action.

const path = require('node:path');
const { BrowserWindow } = require('electron');

const BADGE_TITLE = 'F.R.I.D.A.Y. gesture';
const WIDTH = 220;
const HEIGHT = 56;

class Badge {
  constructor() {
    this.win = null;
    this.loaded = false;
    this.last = null; // state that arrived before the page loaded
  }

  create() {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      resizable: false,
      fullscreenable: false,
      title: BADGE_TITLE,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.setIgnoreMouseEvents(true);
    win.on('page-title-updated', (event) => event.preventDefault());
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-finish-load', () => {
      this.loaded = true;
      if (this.last) this.state(this.last);
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'badge.html'));
    this.win = win;
  }

  get ready() {
    return Boolean(this.win && !this.win.isDestroyed() && this.loaded);
  }

  state(state) {
    this.last = state;
    if (!this.ready) return;
    this.win.webContents.send('badge:state', state);
    if (state.mode === 'off') this.win.hide();
    else if (!this.win.isVisible()) this.win.showInactive();
  }

  action(action) {
    if (this.ready) this.win.webContents.send('badge:action', action);
  }
}

module.exports = { BADGE_TITLE, Badge };
