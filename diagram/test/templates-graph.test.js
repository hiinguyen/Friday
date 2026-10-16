import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { getTemplate } from '../shared/render/registry.js';
import { renderSpec } from '../shared/render/render.js';
import { sampleSpec } from './helpers/samples.js';
import { makeNodes, makeSpec } from './helpers/specs.js';
import { descendantIds } from '../shared/spec/tree.js';

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

const pathPoints = (item) => [...item.d.match(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
  .map((token) => token.slice(1).split(' ').map(Number))
  .map(([x, y]) => ({ x, y }));

const insideBox = (point, box, eps = 0.75) => point.x > box.x + eps && point.x < box.x + box.w - eps
  && point.y > box.y + eps && point.y < box.y + box.h - eps;

function assertProportionalFlowchart(spec) {
  const scene = render(spec);
  assert.ok(scene.height < 1.5 * scene.width, `too tall: ${scene.width}x${scene.height}`);
  assert.ok(scene.width < 2.5 * scene.height, `too wide: ${scene.width}x${scene.height}`);
  assert.equal(arrows(scene).length, spec.edges.length, 'one arrowhead per edge');

  const boxes = Object.entries(scene.nodes);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i][1];
      const b = boxes[j][1];
      const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      assert.ok(!overlap, `nodes ${boxes[i][0]} and ${boxes[j][0]} overlap`);
    }
  }

  const lines = scene.items.filter((item) => item.type === 'path' && item.role === 'connector' && item.fill === 'none');
  for (const line of lines) {
    const points = pathPoints(line);
    for (let s = 0; s < points.length - 1; s += 1) {
      for (let step = 1; step < 10; step += 1) {
        const t = step / 10;
        const point = { x: points[s].x + (points[s + 1].x - points[s].x) * t, y: points[s].y + (points[s + 1].y - points[s].y) * t };
        for (const [id, box] of boxes) {
          assert.ok(!insideBox(point, box), `connector crosses node ${id} at ${point.x.toFixed(1)},${point.y.toFixed(1)}`);
        }
      }
    }
  }
}

test('a branching flowchart stays proportional instead of becoming a column', () => {
  const nodes = makeNodes(12);
  const edges = [
    { from: 'n1', to: 'n2', label: '' }, { from: 'n1', to: 'n3', label: '' },
    { from: 'n2', to: 'n4', label: '' }, { from: 'n3', to: 'n4', label: '' },
    ...Array.from({ length: 8 }, (_, i) => ({ from: `n${i + 4}`, to: `n${i + 5}`, label: '' })),
  ];
  assertProportionalFlowchart(makeSpec({ template: 'flowchart', nodes, edges }));
  assertProportionalFlowchart(sampleSpec(getTemplate('flowchart'), 12));
});

test('flowchart without edges chains the nodes in order', () => {
  const scene = render(makeSpec({ template: 'flowchart', nodes: makeNodes(4), edges: [] }));
  assert.equal(arrows(scene).length, 3);
});

test('flowchart lays a long simple chain out as a serpentine, not a tall column', () => {
  const implicit = makeSpec({ template: 'flowchart', nodes: makeNodes(12), edges: [] });
  const explicit = { ...implicit, edges: Array.from({ length: 11 }, (_, i) => ({ from: `n${i + 1}`, to: `n${i + 2}`, label: '' })) };
  for (const [name, spec] of [['implicit', implicit], ['explicit', explicit]]) {
    const scene = render(spec);
    assert.ok(scene.height < 1.5 * scene.width, `${name}: ${scene.width}x${scene.height} is still a column`);
    assert.equal(arrows(scene).length, spec.nodes.length - 1, name);
    const boxes = Object.values(scene.nodes);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
        assert.ok(!overlap, `${name}: node hit boxes overlap`);
      }
    }
  }
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

const branchExtent = (scene, spec, id) => {
  const boxes = [id, ...descendantIds(spec, id)].map((nodeId) => scene.nodes[nodeId]);
  return Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
};

test('mindmap balances branch blocks across the two sides', () => {
  const spec = sampleSpec(getTemplate('mindmap'), 15, { long: true });
  const scene = render(spec);
  const branchIds = spec.nodes.filter((n) => n.parent === 'n1').map((n) => n.id);
  assert.ok(branchIds.length >= 3);
  const root = scene.nodes.n1;
  const centre = root.x + root.w / 2;
  const sideOf = (id) => (scene.nodes[id].x + scene.nodes[id].w / 2 >= centre ? 'right' : 'left');
  const extent = (side) => {
    const ids = branchIds.filter((id) => sideOf(id) === side).flatMap((id) => [id, ...descendantIds(spec, id)]);
    const boxes = ids.map((id) => scene.nodes[id]);
    return Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
  };
  const tallest = Math.max(...branchIds.map((id) => branchExtent(scene, spec, id)));
  assert.ok(Math.abs(extent('left') - extent('right')) <= tallest, `unbalanced: left ${extent('left')} vs right ${extent('right')}, tallest ${tallest}`);
});
