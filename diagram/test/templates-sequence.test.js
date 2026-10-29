import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { getTemplate } from '../shared/render/registry.js';
import { renderSpec } from '../shared/render/render.js';
import { sampleSpec } from './helpers/samples.js';

const fonts = loadFontSet();
const sceneOf = (id, count) => renderSpec(sampleSpec(getTemplate(id), count), { fontSet: fonts }).scene;

test('icon-row puts every node on one row, left to right', () => {
  const { nodes } = sceneOf('icon-row', 5);
  const xs = ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => nodes[id].x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs);
  assert.equal(new Set(['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => Math.round(nodes[id].y))).size, 1);
});

test('timeline alternates above and below the axis', () => {
  const scene = sceneOf('timeline', 6);
  const axis = scene.items.find((i) => i.type === 'rect' && i.role === 'decoration');
  const above = (id) => scene.nodes[id].y + scene.nodes[id].h <= axis.y;
  assert.deepEqual(['n1', 'n2', 'n3', 'n4'].map(above), [true, false, true, false]);
});

test('steps chevrons go left to right with the detail below', () => {
  const scene = sceneOf('steps', 4);
  const chevrons = scene.items.filter((i) => i.type === 'path' && i.role === 'node-box');
  assert.equal(chevrons.length, 4);
  for (let i = 1; i < 4; i += 1) assert.ok(chevrons[i].bounds.x > chevrons[i - 1].bounds.x);
  const detail = scene.items.find((i) => i.role === 'node-detail' && i.nodeId === 'n1');
  if (detail) assert.ok(detail.y >= chevrons[0].bounds.y + chevrons[0].bounds.h);
});
