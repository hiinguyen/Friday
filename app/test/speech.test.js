'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { SpeechOutput } = require('../src/speech');

function collect(speech) {
  const events = [];
  for (const name of ['ready', 'disabled', 'speech', 'error']) {
    speech.on(name, (payload) => events.push([name, payload]));
  }
  return events;
}

test('translates voice worker JSON lines into typed events', () => {
  const speech = new SpeechOutput();
  const events = collect(speech);
  speech.handleLine('{"type": "ready", "voice": "/v.safetensors"}');
  speech.handleLine('{"type": "speech", "id": 3, "state": "speaking"}');
  speech.handleLine('{"type": "speech", "id": 3, "state": "done"}');
  speech.handleLine('{"type": "speech", "id": 4, "state": "skipped"}');
  speech.handleLine('{"type": "error", "message": "no audio"}');
  assert.deepEqual(events, [
    ['ready', { voice: '/v.safetensors' }],
    ['speech', { id: 3, state: 'speaking' }],
    ['speech', { id: 3, state: 'done' }],
    ['speech', { id: 4, state: 'skipped' }],
    ['error', 'no audio'],
  ]);
});

test('ignores malformed lines and unknown speech states', (t) => {
  t.mock.method(console, 'error', () => {});
  const speech = new SpeechOutput();
  const events = collect(speech);
  speech.handleLine('not json');
  speech.handleLine('{"type": "speech", "id": 1, "state": "singing"}');
  speech.handleLine('{"type": "mystery"}');
  assert.deepEqual(events, []);
  assert.equal(console.error.mock.callCount(), 3);
});

test('commands are dropped, not thrown, while the worker is down', () => {
  const speech = new SpeechOutput();
  assert.doesNotThrow(() => {
    speech.say(1, 'Hello.');
    speech.end(1);
    speech.cancel();
  });
  assert.equal(speech.send({ type: 'cancel' }), false);
});

test('sends say, end and cancel as JSON lines', () => {
  const speech = new SpeechOutput();
  const lines = [];
  speech.child = { stdin: { writable: true, write: (line) => lines.push(line) } };
  speech.say(2, 'Sure.');
  speech.say(2, ''); // empty deltas are not worth a line
  speech.end(2);
  speech.cancel();
  speech.child = null;
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [{ type: 'say', id: 2, text: 'Sure.' }, { type: 'end', id: 2 }, { type: 'cancel' }],
  );
});

test('without a cloned voice the worker reports disabled once and is not restarted', async (t) => {
  t.mock.method(console, 'error', () => {});
  const original = process.env.FRIDAY_TTS_VOICE;
  process.env.FRIDAY_TTS_VOICE = path.join(__dirname, 'no-such-voice.safetensors');
  const speech = new SpeechOutput({ backoffMs: [5] });
  const events = collect(speech);
  try {
    const disabled = new Promise((resolve) => speech.once('disabled', resolve));
    speech.start();
    assert.match(await disabled, /bin\/friday voice/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(
      events.map(([name]) => name),
      ['disabled'],
      'a missing voice is not a crash to retry',
    );
  } finally {
    speech.stop();
    if (original === undefined) delete process.env.FRIDAY_TTS_VOICE;
    else process.env.FRIDAY_TTS_VOICE = original;
  }
});

test('a worker that dies mid-reply reports her done and never resumes mid-sentence', () => {
  const speech = new SpeechOutput();
  const events = collect(speech);
  const lines = [];
  speech.child = { stdin: { writable: true, write: (line) => lines.push(JSON.parse(line)) } };
  speech.say(5, 'The first half. ');
  speech.handleLine('{"type": "speech", "id": 5, "state": "speaking"}');
  speech.emit('down'); // crashed: the supervisor restarts it
  assert.deepEqual(events.at(-1), ['speech', { id: 5, state: 'done' }], 'the HUD must not wait for a done that never comes');
  speech.say(5, 'the second half.');
  speech.end(5);
  speech.say(6, 'A new reply.');
  speech.child = null;
  assert.deepEqual(lines, [
    { type: 'say', id: 5, text: 'The first half. ' },
    { type: 'say', id: 6, text: 'A new reply.' },
  ]);
});

test('a worker going down while idle reports nothing', () => {
  const speech = new SpeechOutput();
  const events = collect(speech);
  speech.handleLine('{"type": "speech", "id": 2, "state": "speaking"}');
  speech.handleLine('{"type": "speech", "id": 2, "state": "done"}');
  speech.emit('down');
  assert.deepEqual(events, [
    ['speech', { id: 2, state: 'speaking' }],
    ['speech', { id: 2, state: 'done' }],
  ]);
});
