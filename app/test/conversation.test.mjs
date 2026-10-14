import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Conversation, isResetCommand, sessionId } = require('../src/conversation.js');

const MINUTE = 60_000;
const IDLE = 10 * MINUTE;
const START = new Date(2026, 9, 14, 20, 31, 5).getTime();

function clock(t = START) {
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-conv-'));
  return path.join(dir, 'state', 'conversation.json');
}

test('session ids are readable local timestamps under the prefix', () => {
  assert.equal(sessionId('friday', START), 'friday-20261014-203105');
});

test('commands close together share a session, a long pause starts a new one', () => {
  const now = clock();
  const conv = new Conversation({ prefix: 'friday', idleMs: IDLE, now });

  const first = conv.begin();
  assert.deepEqual(first, { session: 'friday-20261014-203105', fresh: true });

  now.advance(9 * MINUTE);
  assert.deepEqual(conv.begin(), { session: first.session, fresh: false }, 'a follow-up continues');

  now.advance(IDLE + 1);
  const later = conv.begin();
  assert.equal(later.fresh, true);
  assert.notEqual(later.session, first.session);
});

test('the idle window counts from the end of the reply, not the question', () => {
  const now = clock();
  const conv = new Conversation({ prefix: 'friday', idleMs: IDLE, now });
  const { session } = conv.begin();
  now.advance(8 * MINUTE); // a long agent run
  conv.touch();
  now.advance(8 * MINUTE);
  assert.deepEqual(conv.begin(), { session, fresh: false });
});

test('reset makes the next command start a new conversation', () => {
  const now = clock();
  const conv = new Conversation({ prefix: 'friday', idleMs: IDLE, now });
  const { session } = conv.begin();
  conv.reset();
  now.advance(1000);
  const next = conv.begin();
  assert.equal(next.fresh, true);
  assert.notEqual(next.session, session);
});

test('an empty prefix is stateless: no session, every command fresh', () => {
  const conv = new Conversation({ prefix: '', idleMs: IDLE, now: clock() });
  assert.deepEqual(conv.begin(), { session: '', fresh: true });
  assert.deepEqual(conv.begin(), { session: '', fresh: true });
});

test('a warm conversation survives a restart through the state file', () => {
  const file = tempFile();
  const now = clock();
  const { session } = new Conversation({ prefix: 'friday', idleMs: IDLE, file, now }).begin();
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');

  now.advance(2 * MINUTE);
  const restarted = new Conversation({ prefix: 'friday', idleMs: IDLE, file, now });
  assert.deepEqual(restarted.begin(), { session, fresh: false });
});

test('a saved session of another prefix or a corrupt file is ignored', () => {
  const file = tempFile();
  const now = clock();
  new Conversation({ prefix: 'friday', idleMs: IDLE, file, now }).begin();
  assert.equal(new Conversation({ prefix: 'work', idleMs: IDLE, file, now }).begin().fresh, true);

  fs.writeFileSync(file, '{not json');
  const errors = [];
  const conv = new Conversation({ prefix: 'friday', idleMs: IDLE, file, now, onError: (m) => errors.push(m) });
  assert.equal(conv.begin().fresh, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unreadable/);
});

test('reset phrases match whole commands in English and Vietnamese', () => {
  for (const text of ['New conversation.', 'Start over!', "Let's start over.", 'friday, new chat', 'Cuộc trò chuyện mới.', 'Bắt đầu lại', 'Chuyện khác.']) {
    assert.equal(isResetCommand(text), true, text);
  }
  for (const text of ['Start over the download', 'What is a new conversation?', 'Kể chuyện khác đi', '']) {
    assert.equal(isResetCommand(text), false, text);
  }
});
