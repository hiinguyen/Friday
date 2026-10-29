'use strict';

// CDP over one WebSocket to the user's own Chrome.
//
// Chrome 144+ accepts DevTools connections once the user allowed it at
// chrome://inspect/#remote-debugging, and writes <user-data-dir>/DevToolsActivePort
// (line 1: the port, line 2: the browser WebSocket path like
// /devtools/browser/<uuid>). Chrome asks the user to allow each new connection,
// so Friday keeps ONE connection open for its whole life and reconnects only
// when it drops.
//
//   FRIDAY_BROWSE_CHROME_DIR    Chrome's user data dir (default ~/.config/google-chrome)
//   FRIDAY_BROWSE_CDP_URL       a loopback ws:// URL, for tests and debugging

/* Ported from browser-use/jev-ultrafast (MIT, Copyright (c) 2026 Browser Use). */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DEFAULT_CHROME_DIR = path.join(os.homedir(), '.config', 'google-chrome');
const DEFAULT_CALL_TIMEOUT_MS = 15000;
// Chrome holds the handshake until the user answers its "Allow remote debugging?"
// prompt, which the HUD may cover: give them time, but never wait forever.
const DEFAULT_OPEN_TIMEOUT_MS = 30000;
const PORT_FILE = 'DevToolsActivePort';
const BROWSER_PREFIX = '/devtools/browser/';
// CDP is full control of the browser, so only a URL on this machine is allowed.
const LOOPBACK = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;
const OFF_MESSAGE = 'Chrome remote debugging is off: open chrome://inspect/#remote-debugging in Chrome and allow it';

/** Where Chrome keeps the profile the user runs. */
function browseChromeDir(env = process.env) {
  return env.FRIDAY_BROWSE_CHROME_DIR || DEFAULT_CHROME_DIR;
}

/** The browser WebSocket URL Chrome wrote, or an error explaining how to enable it. */
function readDevToolsUrl({ chromeDir, readFile = fs.readFileSync }) {
  let text;
  try {
    text = String(readFile(path.join(chromeDir, PORT_FILE), 'utf8'));
  } catch {
    throw new Error(OFF_MESSAGE);
  }
  const [portLine, pathLine] = text.split('\n');
  const port = Number.parseInt(portLine, 10);
  const browserPath = (pathLine ?? '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath.startsWith(BROWSER_PREFIX)) {
    throw new Error(OFF_MESSAGE);
  }
  return `ws://127.0.0.1:${port}${browserPath}`;
}

/** One CDP WebSocket: numbered calls, events, and a bounded wait per call. */
class CdpConnection extends EventEmitter {
  constructor({ url, WebSocketImpl = WebSocket, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS }) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.callTimeoutMs = callTimeoutMs;
    this.openTimeoutMs = openTimeoutMs;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.opened = false;
  }

  get isOpen() {
    return this.opened;
  }

  /** Connect and start routing messages; resolves to this connection. */
  async open() {
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const seconds = Math.round(this.openTimeoutMs / 1000);
          reject(new Error(`Chrome did not accept the connection within ${seconds} s: click Allow in Chrome's remote debugging prompt`));
        }, this.openTimeoutMs);
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Chrome connection failed')), { once: true });
      });
    } catch (err) {
      socket.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    this.opened = true;
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.onClose());
    return this;
  }

  /** Send one CDP command; resolves to its result. */
  send(method, params = {}, sessionId) {
    if (!this.opened) return Promise.reject(new Error('Chrome connection closed'));
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      const message = { id, method, params };
      if (sessionId !== undefined) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already gone: onClose below still releases every pending call
      }
    }
    this.onClose();
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return; // a frame that is not JSON is not ours to act on
    }
    if (message.id !== undefined) {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
      else call.resolve(message.result);
      return;
    }
    if (message.method) {
      this.emit('event', { method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
    }
  }

  onClose() {
    const wasOpen = this.opened;
    this.opened = false;
    this.socket = null;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Chrome connection closed'));
    }
    this.pending.clear();
    if (wasOpen) this.emit('close');
  }
}

/**
 * Owns the one connection: lazily connects, reuses it while it is open,
 * reconnects once it closed, and shares one in-flight connect.
 */
class Chrome {
  constructor({ env = process.env, WebSocketImpl = WebSocket, readFile = fs.readFileSync } = {}) {
    this.env = env;
    this.WebSocketImpl = WebSocketImpl;
    this.readFile = readFile;
    this.conn = null;
    this.connecting = null;
  }

  /** The browser WebSocket URL: the override, or the one Chrome wrote. */
  devToolsUrl() {
    const override = this.env.FRIDAY_BROWSE_CDP_URL;
    if (override) {
      if (!LOOPBACK.test(override)) {
        throw new Error(`FRIDAY_BROWSE_CDP_URL must be loopback, got ${override}`);
      }
      return override;
    }
    return readDevToolsUrl({ chromeDir: browseChromeDir(this.env), readFile: this.readFile });
  }

  async connection() {
    if (this.conn?.isOpen) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connect() {
    const conn = new CdpConnection({ url: this.devToolsUrl(), WebSocketImpl: this.WebSocketImpl });
    conn.on('close', () => {
      if (this.conn === conn) this.conn = null;
    });
    await conn.open();
    this.conn = conn;
    return conn;
  }
}

module.exports = { CdpConnection, Chrome, browseChromeDir, readDevToolsUrl };
