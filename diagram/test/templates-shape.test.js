import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { getTemplate, compatibleTemplates } from '../shared/render/registry.js';
import { renderSpec } from '../shared/render/render.js';
import { sampleSpec } from './helpers/samples.js';
import { makeNodes, makeSpec } from './helpers/specs.js';

const fonts = loadFontSet();
const render = (spec) => renderSpec(spec, { fontSet: fonts }).scene;

test('compare lines rows up across columns', () => {
  const spec = sampleSpec(getTemplate('compare'), 9);
  const scene = render(spec);
  const firstRowYs = spec.nodes.filter((n) => n.parent).reduce((acc, n) => {
    if (!acc.has(n.parent)) acc.set(n.parent, scene.nodes[n.id].y);
    return acc;
  }, new Map());
  assert.equal(new Set([...firstRowYs.values()].map(Math.round)).size, 1);
});

test('compare refuses a flat list of five', () => {
  const entry = compatibleTemplates(makeSpec({ nodes: makeNodes(5) })).find((t) => t.id === 'compare');
  assert.equal(entry.ok, false);
});

test('funnel bands get narrower and show values', () => {
  const scene = render(sampleSpec(getTemplate('funnel'), 4));
  const bands = scene.items.filter((i) => i.type === 'path' && i.role === 'node-box');
  for (let i = 1; i < bands.length; i += 1) assert.ok(bands[i].bounds.w < bands[i - 1].bounds.w);
  assert.ok(scene.items.some((i) => i.role === 'node-value' && i.lines[0] === '1.000'));
});

test('pyramid is narrowest at the top', () => {
  const scene = render(sampleSpec(getTemplate('pyramid'), 4));
  const layers = scene.items.filter((i) => i.type === 'path' && i.role === 'node-box');
  assert.ok(layers[0].bounds.w < layers[layers.length - 1].bounds.w);
});

test('venn circles overlap but hit boxes do not', () => {
  const spec = sampleSpec(getTemplate('venn'), 6);
  const scene = render(spec);
  const circles = scene.items.filter((i) => i.type === 'circle' && i.role === 'node-box');
  assert.equal(circles.length, 3);
  const [a, b] = circles;
  assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r);
  const boxes = Object.values(scene.nodes);
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
    const p = boxes[i];
    const q = boxes[j];
    assert.ok(p.x + p.w <= q.x + 0.5 || q.x + q.w <= p.x + 0.5 || p.y + p.h <= q.y + 0.5 || q.y + q.h <= p.y + 0.5);
  }
});
