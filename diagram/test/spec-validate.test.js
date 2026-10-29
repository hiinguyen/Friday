import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../shared/spec/validate.js';
import { makeSpec, makeNodes } from './helpers/specs.js';

test('a well-formed spec has no errors', () => {
  assert.deepEqual(validateSpec(makeSpec()), []);
});

test('reports each bad field by name', () => {
  const errors = validateSpec(makeSpec({ version: 2, title: '', nodes: [{ ...makeNodes(1)[0], label: 'x'.repeat(61), color: '#fff' }] }));
  assert.ok(errors.some((e) => e.includes('version')));
  assert.ok(errors.some((e) => e.includes('title')));
  assert.ok(errors.some((e) => e.includes('label')));
  assert.ok(errors.some((e) => e.includes('color')));
});

test('rejects duplicate ids, unknown parents and parent cycles', () => {
  const nodes = makeNodes(3);
  assert.ok(validateSpec(makeSpec({ nodes: [nodes[0], { ...nodes[1], id: 'n1' }] })).some((e) => e.includes('duplicate')));
  assert.ok(validateSpec(makeSpec({ nodes: [{ ...nodes[0], parent: 'zz' }] })).some((e) => e.includes('parent')));
  const cyclic = [{ ...nodes[0], parent: 'n2' }, { ...nodes[1], parent: 'n1' }];
  assert.ok(validateSpec(makeSpec({ nodes: cyclic })).some((e) => e.includes('cycle')));
});

test('rejects edges to unknown nodes and bad density', () => {
  const errors = validateSpec(makeSpec({ edges: [{ from: 'n1', to: 'n9', label: '' }], style: { theme: 'classic', density: 'huge' } }));
  assert.ok(errors.some((e) => e.includes('edge')));
  assert.ok(errors.some((e) => e.includes('density')));
});

test('does not throw on garbage', () => {
  for (const value of [null, 42, 'x', [], { nodes: 'no' }]) assert.ok(validateSpec(value).length > 0);
});
