import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { wrapText } from '../shared/render/text.js';

const fonts = loadFontSet();

test('measures Vietnamese text with real glyph widths', () => {
  const narrow = fonts.measure('iiii', 16, 400);
  const wide = fonts.measure('MMMM', 16, 400);
  assert.ok(wide > narrow * 2);
  assert.ok(fonts.measure('Lộ trình', 16, 700) > fonts.measure('Lộ trình', 16, 400));
  assert.ok(fonts.ascent(16, 400) > 10 && fonts.descent(16, 400) > 2);
});

test('wraps on spaces and every line fits', () => {
  const result = wrapText(fonts, 'Phỏng vấn ba mươi khách hàng để hiểu nhu cầu thực sự của họ', { size: 16, weight: 400, maxWidth: 160, maxLines: 5 });
  assert.ok(result.lines.length > 1);
  for (const line of result.lines) assert.ok(fonts.measure(line, result.size, 400) <= 160);
  assert.equal(result.truncated, false);
  assert.equal(result.size, 16);
});

test('shrinks before truncating, never below 75 percent', () => {
  const text = 'Một câu khá dài cần thu nhỏ chữ lại để vừa khung';
  const result = wrapText(fonts, text, { size: 20, weight: 600, maxWidth: 220, maxLines: 2 });
  assert.ok(result.size < 20 && result.size >= 15);
  assert.ok(result.lines.length <= 2);
});

test('ellipsizes when even the smallest size does not fit', () => {
  const result = wrapText(fonts, 'chữ '.repeat(80), { size: 16, weight: 400, maxWidth: 120, maxLines: 2 });
  assert.equal(result.lines.length, 2);
  assert.ok(result.lines[1].endsWith('…'));
  assert.equal(result.truncated, true);
  assert.equal(result.size, 12);
  for (const line of result.lines) assert.ok(fonts.measure(line, result.size, 400) <= 120);
});

test('breaks a single word longer than the line', () => {
  const result = wrapText(fonts, 'Siêuuuuuuuuuuuuuuuuuuuuuuuuuuuudài', { size: 16, weight: 400, maxWidth: 80, maxLines: 6 });
  for (const line of result.lines) assert.ok(fonts.measure(line, result.size, 400) <= 80);
});

test('empty text gives no lines', () => {
  assert.deepEqual(wrapText(fonts, '   ', { size: 16, weight: 400, maxWidth: 100, maxLines: 2 }).lines, []);
});
