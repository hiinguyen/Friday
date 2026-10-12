import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceTracker } from '../renderer/hud/voice.js';

const DT = 1 / 60;

/** Feed `level` at 20 Hz for `seconds` while ticking frames at 60 Hz. */
function run(tracker, level, seconds, start = 0) {
  let now = start;
  for (let f = 0; f < seconds * 60; f += 1) {
    now += DT * 1000;
    if (f % 3 === 0) tracker.push(level, now);
    tracker.update(DT, now);
  }
  return now;
}

test('steady background noise settles to zero voice', () => {
  const tracker = new VoiceTracker();
  run(tracker, 0.35, 2);
  assert.ok(tracker.value < 0.05, `value=${tracker.value}`);
  assert.equal(tracker.speaking, false);
});

test('speech well above the noise floor is detected', () => {
  const tracker = new VoiceTracker();
  const now = run(tracker, 0.3, 1);
  run(tracker, 0.75, 0.5, now);
  assert.equal(tracker.speaking, true);
  assert.ok(tracker.lastSpeechAt > now);
});

test('a long sentence is not absorbed into the noise floor', () => {
  const tracker = new VoiceTracker();
  const now = run(tracker, 0.3, 1);
  run(tracker, 0.75, 6, now);
  assert.equal(tracker.speaking, true);
});

test('voice decays when level samples stop arriving', () => {
  const tracker = new VoiceTracker();
  let now = run(tracker, 0.3, 1);
  now = run(tracker, 0.8, 0.5, now);
  for (let f = 0; f < 120; f += 1) {
    now += DT * 1000;
    tracker.update(DT, now);
  }
  assert.ok(tracker.value < 0.05, `value=${tracker.value}`);
});
