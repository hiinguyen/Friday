'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { activeWorkspace, dispatch, request, socketPath } = require('../src/hypr');

// A stand-in for Hyprland's request socket: records each request and answers
// with `reply`, then closes, as Hyprland does. A null reply never answers.
async function fakeHyprland(reply) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hypr-'));
  const socket = path.join(dir, '.socket.sock');
  const received = [];
  const server = net.createServer((conn) => {
    conn.on('error', () => {}); // a client that times out resets the connection
    conn.on('data', (data) => {
      received.push(data.toString());
      if (reply !== null) conn.end(reply);
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { socket, received, close };
}

test('the socket path comes from the Hyprland instance', () => {
  const env = { XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: 'abc_1' };
  assert.equal(socketPath(env), '/run/user/1000/hypr/abc_1/.socket.sock');
  assert.equal(socketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }), null);
});

test('a dispatch sends the dispatcher and resolves on ok', async () => {
  const hypr = await fakeHyprland('ok');
  try {
    await dispatch('workspace e+1', { socket: hypr.socket });
    assert.deepEqual(hypr.received, ['dispatch workspace e+1']);
  } finally {
    await hypr.close();
  }
});

test('a refused dispatch rejects with what Hyprland said', async () => {
  const hypr = await fakeHyprland('Invalid dispatcher');
  try {
    await assert.rejects(dispatch('bogus x', { socket: hypr.socket }), /Invalid dispatcher/);
  } finally {
    await hypr.close();
  }
});

test('the active workspace is parsed from the JSON reply', async () => {
  const hypr = await fakeHyprland('{"id": 3, "name": "3", "monitor": "eDP-2"}');
  try {
    assert.deepEqual(await activeWorkspace({ socket: hypr.socket }), { id: 3, name: '3', monitor: 'eDP-2' });
    assert.deepEqual(hypr.received, ['j/activeworkspace']);
  } finally {
    await hypr.close();
  }
});

test('a Hyprland that never answers times out', async () => {
  const hypr = await fakeHyprland(null);
  try {
    await assert.rejects(request('j/activeworkspace', { socket: hypr.socket, timeoutMs: 50 }), /did not answer/);
  } finally {
    await hypr.close();
  }
});

test('outside Hyprland every request rejects', async () => {
  await assert.rejects(request('j/activeworkspace', { socket: null }), /not running under Hyprland/);
});

test('a missing socket rejects', async () => {
  await assert.rejects(request('j/activeworkspace', { socket: '/nonexistent/.socket.sock' }), /ENOENT/);
});
