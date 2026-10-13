import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommandTracker,
  IDLE_DISMISS_MS,
  REJECTED_DISMISS_MS,
  dismissDeadline,
  stripWakePhrase,
} from '../renderer/hud/command.js';

test('strips only a leading wake phrase', () => {
  assert.equal(stripWakePhrase('Friday, open the browser.'), 'open the browser.');
  assert.equal(stripWakePhrase('Hey Friday. What time is it?'), 'What time is it?');
  assert.equal(stripWakePhrase('Friday'), '');
  assert.equal(stripWakePhrase('See you on Friday'), 'See you on Friday');
});

test('walks listening -> transcribing -> done with live text', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  assert.equal(t.phase, 'listening');
  assert.ok(t.busy);
  t.onCapture({ id: 1, state: 'processing', seconds: 2.4 });
  assert.equal(t.phase, 'transcribing');
  t.onTranscript({ id: 1, delta: 'Friday' });
  assert.equal(t.text, '', 'the wake word alone is not shown');
  t.onTranscript({ id: 1, delta: ', open' });
  t.onTranscript({ id: 1, delta: ' the browser' });
  assert.equal(t.text, 'open the browser');
  assert.ok(t.busy);
  t.onTranscript({ id: 1, text: 'open the browser.', raw: 'Friday, open the browser.', final: true });
  assert.equal(t.phase, 'done');
  assert.equal(t.text, 'open the browser.');
  assert.ok(!t.busy);
});

test('a final transcript with nothing after the wake word counts as empty', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  t.onTranscript({ id: 1, text: '', raw: 'Friday.', final: true });
  assert.equal(t.phase, 'empty');
});

test('silence after the wake word is reported as empty', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  t.onCapture({ id: 1, state: 'empty' });
  assert.equal(t.phase, 'empty');
  assert.ok(!t.busy);
});

test('errors end the command', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 4, state: 'listening' });
  t.onCapture({ id: 4, state: 'processing' });
  t.onTranscript({ id: 4, error: '401 invalid key' });
  assert.equal(t.phase, 'error');
  assert.equal(t.error, '401 invalid key');
  assert.ok(!t.busy);
});

test('events from an older capture are ignored, a newer capture takes over', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 2, state: 'listening' });
  assert.equal(t.onTranscript({ id: 1, text: 'stale', final: true }), false);
  assert.equal(t.phase, 'listening');
  t.onCapture({ id: 3, state: 'listening' });
  t.onTranscript({ id: 3, delta: 'new' });
  assert.equal(t.text, 'new');
});

test('reset returns to idle but keeps stale captures stale', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  t.reset();
  assert.equal(t.phase, 'idle');
  assert.equal(t.text, '');
  assert.equal(t.onTranscript({ id: 1, delta: 'late' }), false);
});

test('a cancelled capture is no longer busy', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  t.onCapture({ id: 1, state: 'cancelled' });
  assert.equal(t.phase, 'empty');
  assert.ok(!t.busy);
});

test('a verified voice keeps transcribing and counts as progress', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 0);
  t.onCapture({ id: 1, state: 'processing', seconds: 2 }, 100);
  t.onCapture({ id: 1, state: 'verified', score: 0.72 }, 50000);
  assert.equal(t.phase, 'transcribing');
  assert.ok(t.busy);
  assert.equal(t.expire(100000), false);
});

test('a rejected voice ends the command without text', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  t.onCapture({ id: 1, state: 'processing', seconds: 2 });
  t.onCapture({ id: 1, state: 'rejected', score: 0.08 });
  assert.equal(t.phase, 'rejected');
  assert.equal(t.text, '');
  assert.ok(!t.busy);
});

test('a voice that cannot be checked is rejected with the reason', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' });
  t.onCapture({ id: 1, state: 'rejected', error: 'file is corrupt; re-enroll' });
  assert.equal(t.phase, 'rejected');
  assert.equal(t.error, 'file is corrupt; re-enroll');
});

test('too little voice to verify ends the command as unclear, with the normal idle window', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 1000);
  t.onCapture({ id: 1, state: 'unclear' }, 3000);
  assert.equal(t.phase, 'unclear');
  assert.ok(!t.busy);
  assert.equal(dismissDeadline(t, 1000, 2500), 2500 + IDLE_DISMISS_MS);
});

test('the HUD powers down after the idle window following the wake or the last speech', () => {
  const t = new CommandTracker();
  assert.equal(dismissDeadline(t, 1000, 0), 1000 + IDLE_DISMISS_MS);
  assert.equal(dismissDeadline(t, 1000, 5000), 5000 + IDLE_DISMISS_MS);
});

test('a rejected voice powers the HUD down soon, however much that person keeps talking', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 1000);
  t.onCapture({ id: 1, state: 'rejected', score: 0.05 }, 6000);
  assert.equal(dismissDeadline(t, 1000, 5500), 6000 + REJECTED_DISMISS_MS);
  assert.equal(dismissDeadline(t, 1000, 8000), 6000 + REJECTED_DISMISS_MS);
});

test('waking again after a rejection restores the normal idle window', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'rejected', score: 0.05 }, 6000);
  assert.equal(dismissDeadline(t, 7000, 0), 7000 + IDLE_DISMISS_MS);
});

test('a command stuck busy past the watchdog becomes an error', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 1000);
  assert.equal(t.expire(1000 + 30000), false);
  assert.ok(t.busy);
  assert.equal(t.expire(1000 + 61000), true);
  assert.equal(t.phase, 'error');
  assert.ok(!t.busy);
  assert.equal(t.expire(1000 + 99000), false, 'expires once');
});

test('progress events restart the watchdog', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 0);
  t.onTranscript({ id: 1, delta: 'open' }, 50000);
  assert.equal(t.expire(100000), false);
});

test('an agent run is busy, streams its reply, and uses the longer watchdog', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 0);
  t.onTranscript({ id: 1, text: 'list the files.', final: true }, 1000);
  assert.ok(!t.busy, 'the transcript alone is not busy');
  t.onAgent({ id: 1, state: 'working', tool: 'terminal' }, 2000);
  assert.equal(t.agent, 'working');
  assert.equal(t.tool, 'terminal');
  assert.ok(t.busy, 'the HUD must stay up while Hermes works');
  assert.equal(t.expire(2000 + 61000), false, 'beyond the speech watchdog but within the agent one');
  t.onReply({ id: 1, delta: 'Here are' }, 30000);
  t.onReply({ id: 1, delta: ' the files.' }, 31000);
  t.onReply({ id: 1, text: 'Here are the files.', final: true }, 32000);
  assert.equal(t.reply, 'Here are the files.');
  assert.equal(t.agent, 'done');
  assert.equal(t.tool, '');
  assert.ok(!t.busy);
});

test('an agent error ends the run with the reason', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 1, state: 'listening' }, 0);
  t.onTranscript({ id: 1, text: 'hello', final: true }, 1000);
  t.onAgent({ id: 1, state: 'working' }, 2000);
  t.onAgent({ id: 1, state: 'error', error: 'Hermes 401: invalid token' }, 3000);
  assert.equal(t.agent, 'error');
  assert.equal(t.error, 'Hermes 401: invalid token');
  assert.ok(!t.busy);
});

test('agent events of an older capture are ignored', () => {
  const t = new CommandTracker();
  t.onCapture({ id: 5, state: 'listening' });
  assert.equal(t.onAgent({ id: 4, state: 'working' }), false);
  assert.equal(t.onReply({ id: 4, delta: 'stale' }), false);
  assert.equal(t.reply, '');
});
