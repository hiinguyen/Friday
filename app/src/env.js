'use strict';

// Every setting lives in ROOT/.env (see .env.example). Loaded once, first thing
// in the main process; the Python helpers it spawns inherit the result. A
// variable already in the real environment wins, so a one-off override like
// `FRIDAY_DEBUG=1 bin/friday` still works.

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const ENV_FILE = path.resolve(__dirname, '..', '..', '.env');

/** Copy the file's variables into process.env without clobbering set ones; returns the names applied. */
function loadEnvFile(file = ENV_FILE, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return []; // no .env: defaults and the real environment
    throw err;
  }
  const applied = [];
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] !== undefined) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

module.exports = { ENV_FILE, loadEnvFile };
