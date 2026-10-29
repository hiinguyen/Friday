import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, getTheme, resolvePaint } from '../shared/render/themes.js';
import { contrastRatio, mixHex } from '../shared/render/color.js';

const AA = 4.5;

for (const theme of Object.values(THEMES)) {
  test(`${theme.id} passes WCAG AA on every pair the renderer uses`, () => {
    const pairs = [
      ['text', theme.text, theme.background], ['text', theme.text, theme.surface],
      ['mutedText', theme.mutedText, theme.background], ['mutedText', theme.mutedText, theme.surface],
    ];
    theme.accents.forEach((accent, i) => {
      pairs.push([`onAccent/accent${i + 1}`, theme.onAccent, accent]);
      pairs.push([`text/tint${i + 1}`, theme.text, mixHex(accent, theme.background, 0.14)]);
      pairs.push([`mutedText/tint${i + 1}`, theme.mutedText, mixHex(accent, theme.background, 0.14)]);
      pairs.push([`text/venn${i + 1}`, theme.text, mixHex(accent, theme.background, 0.3)]);
    });
    for (const [name, fg, bg] of pairs) assert.ok(contrastRatio(fg, bg) >= AA, `${theme.id} ${name}: ${contrastRatio(fg, bg).toFixed(2)}`);
  });
}

test('contrast ratio matches known values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
});

test('paints resolve tokens, tints and opacity', () => {
  const theme = getTheme('classic');
  assert.deepEqual(resolvePaint('accent2', theme), { color: '#0b7a70', opacity: 1 });
  assert.equal(resolvePaint('none', theme), null);
  assert.deepEqual(resolvePaint({ token: 'accent1', opacity: 0.3 }, theme), { color: '#1f6feb', opacity: 0.3 });
  assert.equal(resolvePaint({ token: 'accent1', mix: 0 }, theme).color, '#ffffff');
  assert.equal(getTheme('nope').id, 'classic');
});
