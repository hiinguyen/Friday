import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { LOCAL_ROUTES, isVietnamese, runLocal, timeReply } = require('../src/local.js');

// Thursday 15 October 2026, 20:07 local time.
const NOW = new Date(2026, 9, 15, 20, 7);

function fakeWpctl(volumeLine = 'Volume: 0.84') {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: args[0] === 'get-volume' ? `${volumeLine}\n` : '' };
  };
  return { calls, exec };
}

test('Vietnamese is told apart by its letters', () => {
  assert.ok(isVietnamese('mấy giờ rồi'));
  assert.ok(isVietnamese('Tăng âm lượng'));
  assert.ok(!isVietnamese('what time is it'));
});

test('the time is answered in the language it was asked in', () => {
  assert.equal(timeReply('what time is it', NOW), "It's 8:07 PM, Thursday, October 15.");
  assert.equal(timeReply('mấy giờ rồi', NOW), 'Bây giờ là 20:07, thứ Năm, 15/10/2026.');
});

test('volume up and down step the default sink by 10%, capped at 100%, then report the level', async () => {
  const up = fakeWpctl();
  assert.equal(await runLocal('volume_up', 'turn it up', { exec: up.exec }), 'Volume 84%.');
  assert.deepEqual(up.calls, [
    ['wpctl', 'set-volume', '-l', '1.0', '@DEFAULT_AUDIO_SINK@', '10%+'],
    ['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'],
  ]);
  const down = fakeWpctl('Volume: 0.40');
  assert.equal(await runLocal('volume_down', 'giảm âm lượng', { exec: down.exec }), 'Âm lượng 40%.');
  assert.deepEqual(down.calls[0], ['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '10%-']);
});

test('turning the volume up while muted says it is still muted', async () => {
  const muted = fakeWpctl('Volume: 0.50 [MUTED]');
  assert.equal(await runLocal('volume_up', 'louder', { exec: muted.exec }), 'Volume 50%, still muted.');
  const vi = fakeWpctl('Volume: 0.50 [MUTED]');
  assert.equal(await runLocal('volume_up', 'tăng âm lượng', { exec: vi.exec }), 'Âm lượng 50%, vẫn đang tắt tiếng.');
});

test('mute and unmute set the default sink explicitly', async () => {
  const mute = fakeWpctl();
  assert.equal(await runLocal('mute', 'mute', { exec: mute.exec }), 'Muted.');
  assert.deepEqual(mute.calls, [['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '1']]);
  const unmute = fakeWpctl();
  assert.equal(await runLocal('unmute', 'bật tiếng lên', { exec: unmute.exec }), 'Đã bật tiếng.');
  assert.deepEqual(unmute.calls, [['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '0']]);
});

test('time needs no command and reads the clock it is given', async () => {
  const { calls, exec } = fakeWpctl();
  assert.equal(await runLocal('time', 'what time is it', { exec, now: () => NOW }), "It's 8:07 PM, Thursday, October 15.");
  assert.deepEqual(calls, []);
});

test('a wpctl failure surfaces as an error', async () => {
  const exec = async () => {
    throw new Error('spawn wpctl ENOENT');
  };
  await assert.rejects(runLocal('mute', 'mute', { exec }), /wpctl ENOENT/);
});

test('every local route has a handler, and unknown routes are refused', async () => {
  assert.deepEqual([...LOCAL_ROUTES].sort(), ['mute', 'time', 'unmute', 'volume_down', 'volume_up']);
  await assert.rejects(runLocal('agent', 'x', { exec: fakeWpctl().exec }), /not a local route/);
});
