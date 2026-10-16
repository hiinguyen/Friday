import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { renderSpec } from '../shared/render/render.js';
import { sceneToSvg } from '../shared/render/svg.js';
import { getTheme } from '../shared/render/themes.js';
import { makeSpec } from './helpers/specs.js';

const fonts = loadFontSet();

test('text is real text by default and paths when asked', () => {
  const spec = makeSpec({ title: 'Lộ trình <A&B>' });
  const plain = renderSpec(spec, { fontSet: fonts }).svg;
  assert.ok(plain.includes('Lộ trình &lt;A&amp;B&gt;'));
  const paths = renderSpec(spec, { fontSet: fonts, textAsPaths: true }).svg;
  assert.ok(!paths.includes('<text'));
  assert.ok(!paths.includes('Lộ trình'));
});

test('switching theme only changes colours', () => {
  const { scene } = renderSpec(makeSpec(), { fontSet: fonts });
  const classic = sceneToSvg(scene, getTheme('classic'), { fontSet: fonts });
  const midnight = sceneToSvg(scene, getTheme('midnight'), { fontSet: fonts });
  assert.notEqual(classic, midnight);
  assert.ok(midnight.includes('#0e1424'));
  const textOf = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(textOf(classic), textOf(midnight));
  assert.equal(classic.match(/data-node-id/g).length, midnight.match(/data-node-id/g).length);
});

test('unknown icons fall back to the circle icon', () => {
  const scene = { width: 100, height: 100, nodes: {}, items: [{ type: 'icon', name: 'nope', x: 10, y: 10, size: 24, color: 'text' }] };
  const svg = sceneToSvg(scene, getTheme('classic'), { fontSet: fonts });
  assert.ok(svg.includes('<circle'));
});

test('background can be left out for transparent exports', () => {
  const { scene } = renderSpec(makeSpec(), { fontSet: fonts });
  assert.ok(sceneToSvg(scene, getTheme('classic'), { fontSet: fonts }).includes('data-role="background"'));
  assert.ok(!sceneToSvg(scene, getTheme('classic'), { fontSet: fonts, background: false }).includes('data-role="background"'));
});
