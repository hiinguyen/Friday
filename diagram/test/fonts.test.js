import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';

const fonts = loadFontSet();

const VIETNAMESE = ['Kiểm thử', 'Phỏng vấn sâu', 'Lộ trình ra mắt', 'Đo lường', 'Nghiên cứu khách hàng', 'Báo cáo hằng tuần'];
const WEIGHTS = [400, 500, 600, 700];

// Deterministic 32-bit PRNG (mulberry32) so the offsets are the same on every run.
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('pathData never emits NaN for the reported repro', () => {
  const data = fonts.pathData('Kiểm thử', 536.974, 296.7975, 17, 600);
  assert.ok(!data.includes('NaN'), data.slice(0, 200));
});

test('pathData stays finite for 2000 random offsets and Vietnamese strings', () => {
  const random = makeRandom(20261016);
  for (let i = 0; i < 2000; i += 1) {
    const text = VIETNAMESE[i % VIETNAMESE.length];
    const x = random() * 2000 - 500;
    const y = random() * 2000 - 500;
    const size = 8 + random() * 40;
    const weight = WEIGHTS[i % WEIGHTS.length];
    const data = fonts.pathData(text, x, y, size, weight);
    assert.ok(!data.includes('NaN'), `NaN at i=${i} text="${text}" x=${x} y=${y} size=${size} weight=${weight}`);
  }
});

test('pathData is a closed-wellformed path string', () => {
  const data = fonts.pathData('Kiểm thử', 0, 0, 17, 600);
  assert.match(data, /^M/);
  assert.ok(!/[,;]/.test(data), 'numbers are separated by spaces only');
  assert.ok(!data.includes('undefined'), data);
});
