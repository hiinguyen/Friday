import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { getTemplate } from '../shared/render/registry.js';
import { renderSpec } from '../shared/render/render.js';
import { sampleSpec } from './helpers/samples.js';
import { makeNodes, makeSpec } from './helpers/specs.js';

const fonts = loadFontSet();
const render = (spec) => renderSpec(spec, { fontSet: fonts }).scene;
const arrows = (scene) => scene.items.filter((i) => i.type === 'path' && i.fill !== 'none' && i.role === 'connector');

const arcPaths = (scene) => scene.items.filter((i) => i.type === 'path' && i.fill === 'none' && i.role === 'connector');
const arcInfo = (arc) => {
  const numbers = arc.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const radius = numbers[2];
  const start = { x: numbers[0], y: numbers[1] };
  const end = { x: numbers[numbers.length - 2], y: numbers[numbers.length - 1] };
  const cx = arc.bounds.x + radius;
  const cy = arc.bounds.y + radius;
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  const a1 = Math.atan2(end.y - cy, end.x - cx);
  const span = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return { start, end, length: radius * span };
};
const outsideBox = (point, box) => point.x <= box.x || point.x >= box.x + box.w || point.y <= box.y || point.y >= box.y + box.h;

test('cycle draws one visible arc per pair, with endpoints clear of every node', () => {
  const cycle = getTemplate('cycle');
  for (const count of [3, 5, 8]) {
    for (const long of [false, true]) {
      const spec = sampleSpec(cycle, count, { long });
      const scene = render(spec);
      const arcs = arcPaths(scene);
      assert.equal(arcs.length, count, `cycle ${count} long=${long} drew ${arcs.length} arcs`);
      for (const arc of arcs) {
        const { start, end, length } = arcInfo(arc);
        assert.ok(length >= 23, `arc between boxes is only ${length.toFixed(1)}px (count ${count}, long ${long})`);
        for (const point of [start, end]) {
          for (const [id, box] of Object.entries(scene.nodes)) {
            assert.ok(outsideBox(point, box), `arc end ${point.x},${point.y} is inside ${id} (count ${count}, long ${long})`);
          }
        }
      }
    }
  }
});

test('flowchart draws one arrow per edge', () => {
  const spec = sampleSpec(getTemplate('flowchart'), 5);
  assert.equal(arrows(render(spec)).length, spec.edges.length);
});

test('flowchart without edges chains the nodes in order', () => {
  const scene = render(makeSpec({ template: 'flowchart', nodes: makeNodes(4), edges: [] }));
  assert.equal(arrows(scene).length, 3);
});

test('cycle closes the loop', () => {
  const scene = render(sampleSpec(getTemplate('cycle'), 5));
  assert.equal(arrows(scene).length, 5);
});

test('tree puts children below their parent', () => {
  const spec = sampleSpec(getTemplate('tree'), 7);
  const scene = render(spec);
  for (const node of spec.nodes.filter((n) => n.parent)) {
    const parent = scene.nodes[node.parent];
    assert.ok(scene.nodes[node.id].y >= parent.y + parent.h, `${node.id} is not below ${node.parent}`);
  }
});

test('mindmap puts branches on both sides of the root', () => {
  const spec = sampleSpec(getTemplate('mindmap'), 9);
  const scene = render(spec);
  const root = scene.nodes.n1;
  const branches = spec.nodes.filter((n) => n.parent === 'n1').map((n) => scene.nodes[n.id]);
  assert.ok(branches.some((b) => b.x > root.x + root.w));
  assert.ok(branches.some((b) => b.x + b.w < root.x));
});

test('mindmap with several roots uses a synthetic centre without a hit box', () => {
  const scene = render(makeSpec({ template: 'mindmap', title: 'Trung tâm', nodes: makeNodes(4) }));
  assert.equal(Object.keys(scene.nodes).length, 4);
});
