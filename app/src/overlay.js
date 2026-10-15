'use strict';

// The small windows of gesture mode (the badge, the debug view): shown while
// gesture mode is on, hidden when it is off. They are never focusable, so a
// "carry the window" gesture always moves the owner's window, not one of
// these, and they let clicks through. hypr/friday.conf places them by title.

const path = require('node:path');
const { BrowserWindow } = require('electron');

class GestureOverlay {
  /**
   * @param {{title: string, width: number, height: number, page: string, stateChannel: string}} options
   *   page is the HTML file in app/renderer; stateChannel carries GestureControl's state to it.
   */
  constructor({ title, width, height, page, stateChannel }) {
    Object.assign(this, { title, width, height, page, stateChannel });
    this.win = null;
    this.loaded = false;
    this.last = null; // state that arrived before the page loaded
  }

  create() {
    const win = new BrowserWindow({
      width: this.width,
      height: this.height,
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
      title: this.title,
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
    win.loadFile(path.join(__dirname, '..', 'renderer', this.page));
    this.win = win;
  }

  get ready() {
    return Boolean(this.win && !this.win.isDestroyed() && this.loaded);
  }

  get visible() {
    return this.ready && this.win.isVisible();
  }

  state(state) {
    this.last = state;
    if (!this.ready) return;
    this.win.webContents.send(this.stateChannel, state);
    if (state.mode === 'off') this.win.hide();
    else if (!this.win.isVisible()) this.win.showInactive();
  }

  send(channel, payload) {
    if (this.ready) this.win.webContents.send(channel, payload);
  }
}

module.exports = { GestureOverlay };
