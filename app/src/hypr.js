'use strict';

// Hyprland's IPC request socket, the one hyprctl talks to: one request per
// connection, and the reply is everything Hyprland writes before it closes
// the connection. Talking to it directly keeps a gesture's dispatch well
// under the time it takes to spawn hyprctl.

const net = require('node:net');
const path = require('node:path');

const TIMEOUT_MS = 2000;

/** The request socket of the Hyprland instance this process runs under, or null. */
function socketPath(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR;
  const instance = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!runtime || !instance) return null;
  return path.join(runtime, 'hypr', instance, '.socket.sock');
}

/** Send one request (e.g. "dispatch workspace e+1", "j/activeworkspace"); resolves to the reply. */
function request(command, { socket = socketPath(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket) {
      reject(new Error('not running under Hyprland (HYPRLAND_INSTANCE_SIGNATURE is unset)'));
      return;
    }
    const chunks = [];
    const conn = net.createConnection(socket, () => conn.write(command));
    conn.setTimeout(timeoutMs, () => {
      conn.destroy(new Error(`Hyprland did not answer "${command}" within ${timeoutMs}ms`));
    });
    conn.on('data', (chunk) => chunks.push(chunk));
    conn.on('error', reject);
    conn.on('close', (hadError) => {
      if (!hadError) resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Run a dispatcher, e.g. "workspace e+1"; rejects with Hyprland's reply unless it is "ok". */
async function dispatch(args, options) {
  const reply = (await request(`dispatch ${args}`, options)).trim();
  if (reply !== 'ok') throw new Error(`Hyprland refused "dispatch ${args}": ${reply}`);
}

/** The focused workspace: {id, name, monitor, ...}. */
async function activeWorkspace(options) {
  return JSON.parse(await request('j/activeworkspace', options));
}

module.exports = { activeWorkspace, dispatch, request, socketPath };
