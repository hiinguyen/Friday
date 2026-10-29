import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setField, addNode, removeNode, moveNode, setTemplate, setStyle } from '../shared/spec/ops.js';
import { makeSpec, makeNodes } from './helpers/specs.js';

test('setField changes one field, locks it and leaves the input untouched', () => {
  const spec = makeSpec();
  const before = structuredClone(spec);
  const next = setField(spec, 'n2.label', 'Thiết kế');
  assert.equal(next.nodes[1].label, 'Thiết kế');
  assert.deepEqual(next.locks, ['n2.label']);
  assert.deepEqual(spec, before);
});

test('setField clips text, and does not lock emphasis', () => {
  const next = setField(setField(makeSpec(), 'title', 't'.repeat(100)), 'n1.emphasis', true);
  assert.equal(next.title.length, 80);
  assert.equal(next.nodes[0].emphasis, true);
  assert.deepEqual(next.locks, ['title']);
});

test('setField rejects unknown paths and nodes', () => {
  assert.throws(() => setField(makeSpec(), 'n9.label', 'x'), /n9/);
  assert.throws(() => setField(makeSpec(), 'n1.parent', 'x'), /parent/);
});

test('addNode inserts a sibling after the given node', () => {
  const { spec, nodeId } = addNode(makeSpec(), { after: 'n1' });
  assert.equal(nodeId, 'n4');
  assert.deepEqual(spec.nodes.map((n) => n.id), ['n1', 'n4', 'n2', 'n3']);
  assert.ok(spec.locks.includes('nodes.order'));
});

test('addNode with a parent adds a child', () => {
  const { spec, nodeId } = addNode(makeSpec(), { parent: 'n2' });
  assert.equal(spec.nodes.find((n) => n.id === nodeId).parent, 'n2');
});

test('removeNode lifts children, drops edges and locks of the node', () => {
  const nodes = makeNodes(3);
  const spec = makeSpec({ nodes: [nodes[0], { ...nodes[1], parent: 'n1' }, { ...nodes[2], parent: 'n2' }], edges: [{ from: 'n1', to: 'n2', label: '' }], locks: ['n2.label', 'title'] });
  const next = removeNode(spec, 'n2');
  assert.deepEqual(next.nodes.map((n) => [n.id, n.parent]), [['n1', null], ['n3', 'n1']]);
  assert.deepEqual(next.edges, []);
  assert.deepEqual(next.locks.sort(), ['nodes.order', 'title']);
});

test('moveNode swaps siblings only and is a no-op at the ends', () => {
  const spec = makeSpec();
  assert.deepEqual(moveNode(spec, 'n2', -1).nodes.map((n) => n.id), ['n2', 'n1', 'n3']);
  assert.deepEqual(moveNode(spec, 'n1', -1).nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
  const nodes = makeNodes(3);
  const tree = makeSpec({ nodes: [nodes[0], { ...nodes[1], parent: 'n1' }, nodes[2]] });
  assert.deepEqual(moveNode(tree, 'n1', 1).nodes.map((n) => n.id), ['n3', 'n2', 'n1']);
});

test('setTemplate and setStyle do not lock', () => {
  const next = setStyle(setTemplate(makeSpec(), 'steps'), { theme: 'ocean' });
  assert.equal(next.template, 'steps');
  assert.deepEqual(next.style, { theme: 'ocean', density: 'normal' });
  assert.deepEqual(next.locks, []);
});
