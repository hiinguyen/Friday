import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { CdpConnection, Chrome, browseChromeDir, readDevToolsUrl } = require('../src/browse/cdp.js');

/** A browser-style WebSocket: an EventTarget with send/close and helper dispatchers. */
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeSocket.instances.push(this);
    // The real socket opens on its own; keep that asynchronous so open() can listen first.
    queueMicrotask(() => this.open());
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((h) => h !== handler));
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.dispatch('close', {});
  }

  dispatch(type, event) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }

  open() {
    this.dispatch('open', {});
  }

  message(message) {
    this.dispatch('message', { data: JSON.stringify(message) });
  }
}

async function connect(options = {}) {
  const conn = new CdpConnection({ url: 'ws://127.0.0.1:9222/devtools/browser/abc', WebSocketImpl: FakeSocket, ...options });
  await conn.open();
  return { conn, socket: FakeSocket.instances.at(-1) };
}

test('request ids increase and replies resolve the matching promise', async () => {
  FakeSocket.instances = [];
  const { conn, socket } = await connect();
  const first = conn.send('Page.enable');
  const second = conn.send('Runtime.evaluate', { expression: '1 + 1' });
  assert.deepEqual(socket.sent.map((m) => m.id), [1, 2]);
  assert.deepEqual(socket.sent.map((m) => m.method), ['Page.enable', 'Runtime.evaluate']);
  socket.message({ id: 2, result: { value: 2 } });
  socket.message({ id: 1, result: {} });
  assert.deepEqual(await first, {});
  assert.deepEqual(await second, { value: 2 });
});

test('a message with a sessionId carries it, and an event is emitted', async () => {
  FakeSocket.instances = [];
  const { conn, socket } = await connect();
  const events = [];
  conn.on('event', (event) => events.push(event));
  conn.send('Runtime.evaluate', { expression: '1' }, 'session-1');
  assert.equal(socket.sent[0].sessionId, 'session-1');
  const noSession = conn.send('Runtime.evaluate', { expression: '1' });
  assert.ok(!('sessionId' in socket.sent[1]), 'sessionId is omitted when undefined');
  socket.message({ id: 1, result: {} });
  socket.message({ id: 2, result: {} });
  await noSession;
  socket.message({ method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: 'session-1' });
  assert.deepEqual(events, [{ method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: 'session-1' }]);
});

test('a CDP error reply rejects with the method name and message', async () => {
  FakeSocket.instances = [];
  const { conn, socket } = await connect();
  const pending = conn.send('Page.navigate', { url: 'https://x' });
  socket.message({ id: 1, error: { code: -32000, message: 'Cannot navigate' } });
  await assert.rejects(pending, /Page\.navigate: Cannot navigate/);
});

test('a call that never answers times out', async () => {
  FakeSocket.instances = [];
  const { conn } = await connect({ callTimeoutMs: 20 });
  await assert.rejects(conn.send('Page.enable'), /CDP Page\.enable timed out/);
});

test('closing rejects every pending call and reports it', async () => {
  FakeSocket.instances = [];
  const { conn, socket } = await connect();
  const events = [];
  conn.on('close', () => events.push('close'));
  const pending = conn.send('Page.enable');
  conn.close();
  assert.equal(socket.closed, true);
  assert.equal(conn.isOpen, false);
  await assert.rejects(pending, /Chrome connection closed/);
  assert.deepEqual(events, ['close']);
});

test('readDevToolsUrl reads the port and browser path Chrome wrote', () => {
  const readFile = () => '9222\n/devtools/browser/abc\n';
  assert.equal(readDevToolsUrl({ chromeDir: '/tmp/chrome', readFile }), 'ws://127.0.0.1:9222/devtools/browser/abc');
});

test('readDevToolsUrl explains how to turn remote debugging on', () => {
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.throws(() => readDevToolsUrl({ chromeDir: '/tmp/chrome', readFile: missing }), /chrome:\/\/inspect\/#remote-debugging/);
  assert.throws(() => readDevToolsUrl({ chromeDir: '/tmp/chrome', readFile: () => 'abc\n/devtools/browser/x\n' }), /remote debugging is off/);
  assert.throws(() => readDevToolsUrl({ chromeDir: '/tmp/chrome', readFile: () => '9222\n/devtools/page/x\n' }), /remote debugging is off/);
  assert.throws(() => readDevToolsUrl({ chromeDir: '/tmp/chrome', readFile: () => '0\n/devtools/browser/x\n' }), /remote debugging is off/);
});

test('browseChromeDir uses the override or the default Chrome profile', () => {
  assert.equal(browseChromeDir({ FRIDAY_BROWSE_CHROME_DIR: '/tmp/profile' }), '/tmp/profile');
  assert.match(browseChromeDir({}), /\.config\/google-chrome$/);
});

test('Chrome reuses one connection for two calls and replaces it after close', async () => {
  FakeSocket.instances = [];
  const chrome = new Chrome({ env: { FRIDAY_BROWSE_CDP_URL: 'ws://127.0.0.1:9222/devtools/browser/abc' }, WebSocketImpl: FakeSocket });
  const first = await chrome.connection();
  const second = await chrome.connection();
  assert.equal(first, second);
  assert.equal(FakeSocket.instances.length, 1, 'one socket for both callers');
  first.close();
  const third = await chrome.connection();
  assert.notEqual(third, first);
  assert.equal(FakeSocket.instances.length, 2);
});

test('Chrome shares one in-flight connection between concurrent callers', async () => {
  FakeSocket.instances = [];
  const chrome = new Chrome({ env: { FRIDAY_BROWSE_CDP_URL: 'ws://127.0.0.1:9222/devtools/browser/abc' }, WebSocketImpl: FakeSocket });
  const first = chrome.connection();
  const second = chrome.connection();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(FakeSocket.instances.length, 1);
});

test('Chrome connects to the DevToolsActivePort file when no URL is set', async () => {
  FakeSocket.instances = [];
  const chrome = new Chrome({ env: {}, WebSocketImpl: FakeSocket, readFile: () => '9222\n/devtools/browser/abc\n' });
  const conn = await chrome.connection();
  assert.equal(conn.url, 'ws://127.0.0.1:9222/devtools/browser/abc');
});

test('Chrome refuses a non-loopback CDP URL: it is full control of the browser', async () => {
  FakeSocket.instances = [];
  const chrome = new Chrome({ env: { FRIDAY_BROWSE_CDP_URL: 'ws://evil.example/devtools/browser/x' }, WebSocketImpl: FakeSocket });
  await assert.rejects(chrome.connection(), /loopback/);
  assert.equal(FakeSocket.instances.length, 0);
});

test('a connection Chrome never accepts fails after openTimeoutMs, with how to allow it', async () => {
  // Chrome holds the handshake while its "Allow remote debugging?" prompt waits for the user.
  class SilentSocket extends FakeSocket {
    open() {}
  }
  const conn = new CdpConnection({ url: 'ws://127.0.0.1:9222/devtools/browser/abc', WebSocketImpl: SilentSocket, openTimeoutMs: 20 });
  await assert.rejects(conn.open(), /did not accept the connection.*Allow/);
  assert.equal(FakeSocket.instances.at(-1).closed, true, 'the pending socket is closed');
  assert.equal(conn.isOpen, false);
});
