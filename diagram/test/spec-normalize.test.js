import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec } from '../shared/spec/normalize.js';
import { validateSpec } from '../shared/spec/validate.js';
import { makeSpec, makeNodes, LIST_TEMPLATE, TREE_TEMPLATE, FLOW_TEMPLATE } from './helpers/specs.js';

const ICONS = ['circle', 'rocket'];
const run = (raw, template = LIST_TEMPLATE) => normalizeSpec(raw, { template, iconNames: ICONS, sectionId: 's9' });

test('fills defaults and produces a valid spec from a minimal agent answer', () => {
  const { spec } = run({ title: 'T', nodes: [{ label: 'A' }, { label: 'B', icon: 'rocket' }] });
  assert.deepEqual(validateSpec(spec), []);
  assert.equal(spec.template, 'cards');
  assert.equal(spec.sectionId, 's9');
  assert.deepEqual(spec.nodes.map((n) => [n.id, n.icon]), [['n1', 'circle'], ['n2', 'rocket']]);
  assert.deepEqual(spec.style, { theme: 'classic', density: 'normal' });
});

test('does not mutate its input', () => {
  const raw = makeSpec({ nodes: [{ ...makeNodes(1)[0], icon: 'nope' }] });
  const before = structuredClone(raw);
  run(raw);
  assert.deepEqual(raw, before);
});

test('truncates long text with an ellipsis and reports it', () => {
  const { spec, repairs } = run(makeSpec({ nodes: makeNodes(2, { label: 'á'.repeat(70), detail: 'b'.repeat(200) }) }));
  assert.equal(spec.nodes[0].label.length, 60);
  assert.ok(spec.nodes[0].label.endsWith('…'));
  assert.equal(spec.nodes[0].detail.length, 160);
  assert.ok(repairs.length > 0);
});

test('repairs duplicate ids, unknown icons, bad colours and dangling parents', () => {
  const nodes = [{ id: 'a', label: 'A', icon: 'zzz', color: 'red' }, { id: 'a', label: 'B', parent: 'ghost' }];
  const { spec } = run({ nodes }, TREE_TEMPLATE);
  assert.deepEqual(spec.nodes.map((n) => n.id), ['a', 'n1']);
  assert.equal(spec.nodes[0].icon, 'circle');
  assert.equal(spec.nodes[0].color, null);
  assert.equal(spec.nodes[1].parent, null);
});

test('breaks parent cycles', () => {
  const nodes = [{ id: 'a', label: 'A', parent: 'b' }, { id: 'b', label: 'B', parent: 'a' }];
  const { spec } = run({ nodes }, TREE_TEMPLATE);
  assert.deepEqual(validateSpec(spec), []);
});

test('clears parents and edges the template does not use', () => {
  const nodes = makeNodes(3);
  const { spec } = run({ nodes: [nodes[0], { ...nodes[1], parent: 'n1' }, nodes[2]], edges: [{ from: 'n1', to: 'n2' }] });
  assert.equal(spec.nodes[1].parent, null);
  assert.deepEqual(spec.edges, []);
});

test('keeps valid edges for graph templates and drops broken ones', () => {
  const edges = [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n2' }, { from: 'n3', to: 'n9' }];
  const { spec } = run({ nodes: makeNodes(3), edges }, FLOW_TEMPLATE);
  assert.deepEqual(spec.edges, [{ from: 'n1', to: 'n2', label: '' }]);
});

test('truncates to the template maximum and cleans references to removed nodes', () => {
  const nodes = makeNodes(12);
  nodes[1] = { ...nodes[1], parent: 'n12' };
  const { spec, repairs } = run({ nodes }, { ...TREE_TEMPLATE, maxNodes: 10 });
  assert.equal(spec.nodes.length, 10);
  assert.equal(spec.nodes[1].parent, null);
  assert.ok(repairs.some((r) => r.includes('10')));
});

test('reports too few nodes without inventing any', () => {
  const { spec, repairs } = run({ nodes: [{ label: 'only' }] });
  assert.equal(spec.nodes.length, 1);
  assert.ok(repairs.some((r) => r.includes('too few nodes')));
});
