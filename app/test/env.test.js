'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadEnvFile } = require('../src/env.js');

function envFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'friday-env-')), '.env');
  fs.writeFileSync(file, text);
  return file;
}

test('every variable in .env is loaded, quotes and comments handled', () => {
  const env = {};
  const file = envFile('# comment\nFRIDAY_MIC=alsa_input.usb\nFRIDAY_TTS="off"\n# FRIDAY_DEBUG=1\nOPENAI_API_KEY=sk-test\n');
  assert.deepEqual(loadEnvFile(file, env).sort(), ['FRIDAY_MIC', 'FRIDAY_TTS', 'OPENAI_API_KEY']);
  assert.deepEqual(env, { FRIDAY_MIC: 'alsa_input.usb', FRIDAY_TTS: 'off', OPENAI_API_KEY: 'sk-test' });
});

test('the real environment wins over .env, even when set empty', () => {
  const env = { FRIDAY_MIC: 'from-shell', FRIDAY_AGENT_SESSION: '' };
  loadEnvFile(envFile('FRIDAY_MIC=from-file\nFRIDAY_AGENT_SESSION=friday\n'), env);
  assert.deepEqual(env, { FRIDAY_MIC: 'from-shell', FRIDAY_AGENT_SESSION: '' });
});

test('a missing .env is not an error', () => {
  const env = {};
  assert.deepEqual(loadEnvFile(path.join(os.tmpdir(), 'friday-no-such-dir', '.env'), env), []);
  assert.deepEqual(env, {});
});
