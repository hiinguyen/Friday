import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLocks } from '../shared/spec/locks.js';
import { makeSpec, makeNodes } from './helpers/specs.js';

test('locked fields survive a refine that changed them', () => {
  const edited = makeSpec({ title: 'Của tôi', locks: ['title', 'n2.label'] });
  edited.nodes[1] = { ...edited.nodes[1], label: 'Sửa tay' };
  const revised = makeSpec({ title: 'AI đổi', nodes: makeNodes(3, { label: 'AI' }) });
  const result = applyLocks(edited, revised);
  assert.equal(result.title, 'Của tôi');
  assert.equal(result.nodes[1].label, 'Sửa tay');
  assert.equal(result.nodes[0].label, 'AI');
  assert.deepEqual(result.locks.sort(), ['n2.label', 'title']);
});

test('a locked node the agent dropped comes back', () => {
  const edited = makeSpec({ locks: ['n3.label'] });
  const revised = makeSpec({ nodes: makeNodes(2) });
  assert.deepEqual(applyLocks(edited, revised).nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
});

test('a locked order is kept and new nodes follow', () => {
  const nodes = makeNodes(3);
  const edited = makeSpec({ nodes: [nodes[2], nodes[0], nodes[1]], locks: ['nodes.order'] });
  const revised = makeSpec({ nodes: [...makeNodes(4)] });
  assert.deepEqual(applyLocks(edited, revised).nodes.map((n) => n.id), ['n3', 'n1', 'n2', 'n4']);
});
