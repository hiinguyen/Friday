'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = [
  'hud:wake',
  'hud:level',
  'hud:stats',
  'hud:status',
  'hud:dismiss',
  'hud:capture',
  'hud:transcript',
  'hud:agent',
  'hud:reply',
  'hud:speech',
  'badge:state',
  'badge:action',
  'gesture-debug:state',
  'gesture-debug:frame',
];

contextBridge.exposeInMainWorld('friday', {
  on(channel, callback) {
    if (!INBOUND.includes(channel)) throw new Error(`unknown channel: ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => callback(payload));
  },
  /** Report that the power-down animation of session `seq` finished. */
  hidden: (seq) => ipcRenderer.send('hud:hidden', seq),
});
