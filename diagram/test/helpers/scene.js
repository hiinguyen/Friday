import assert from 'node:assert/strict';

const EPS = 0.5;

export function itemBounds(item) {
  switch (item.type) {
    case 'rect': return { x: item.x, y: item.y, w: item.w, h: item.h };
    case 'circle': return { x: item.cx - item.r, y: item.cy - item.r, w: item.r * 2, h: item.r * 2 };
    case 'path': return item.bounds;
    case 'text': return item.box;
    case 'icon': return { x: item.x, y: item.y, w: item.size, h: item.size };
    default: throw new Error(`unknown item type ${item.type}`);
  }
}

function overlaps(a, b) {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

export function assertSceneInvariants(scene, spec, fontSet, { allowNodeOverlap = false } = {}) {
  assert.ok(Number.isFinite(scene.width) && scene.width > 0, 'width');
  assert.ok(Number.isFinite(scene.height) && scene.height > 0, 'height');
  for (const item of scene.items) {
    const b = itemBounds(item);
    for (const v of [b.x, b.y, b.w, b.h]) assert.ok(Number.isFinite(v), `${item.type} ${item.role} has a non-finite bound`);
    assert.ok(b.x >= -EPS && b.y >= -EPS && b.x + b.w <= scene.width + EPS && b.y + b.h <= scene.height + EPS,
      `${item.type} ${item.role} ${item.nodeId ?? ''} is outside the canvas: ${JSON.stringify(b)} in ${scene.width}x${scene.height}`);
    if (item.type === 'text') {
      for (const line of item.lines) {
        assert.ok(fontSet.measure(line, item.size, item.weight) <= item.box.w + EPS, `line "${line}" overflows its box`);
      }
      assert.ok(item.lines.length * item.lineHeight <= item.box.h + EPS, 'text taller than its box');
    }
  }
  for (const node of spec.nodes) assert.ok(scene.nodes[node.id], `node ${node.id} has no hit box`);
  if (!allowNodeOverlap) {
    const boxes = Object.entries(scene.nodes);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        assert.ok(!overlaps(boxes[i][1], boxes[j][1]), `nodes ${boxes[i][0]} and ${boxes[j][0]} overlap`);
      }
    }
  }
}
