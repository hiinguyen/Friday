import { roots, childrenOf, depthOf } from '../../spec/tree.js';
import { CANVAS_WIDTH, CONTENT_WIDTH, MARGIN, titleBlock, nodeText, accentFor, boxFill, pathItem, finishScene } from '../kit.js';

const BOX_WIDTH = 160;
const ICON_SIZE = 22;
const ICON_GAP = 6;
// A level wider than this many boxes stacks its children as vertical lists instead.
const COMPACT_WIDTH = 4;
const SPINE_X = 14;
const SPINE_OFFSET = 28;

function nodeBox(ctx, node, { x, y, width, fill, accent, onFill = false }) {
  const { pad } = ctx.density;
  const items = [];
  const text = nodeText(ctx, node, { x: x + width / 2, y: y + pad + ICON_SIZE + ICON_GAP, width: width - 2 * pad, anchor: 'middle', onFill, labelLines: 3, detailLines: 3 });
  const height = pad + ICON_SIZE + ICON_GAP + text.height + pad;
  items.push({ type: 'rect', x, y, w: width, h: height, radius: 'theme', fill, stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
  items.push({ type: 'icon', name: node.icon, x: x + width / 2 - ICON_SIZE / 2, y: y + pad, size: ICON_SIZE, color: onFill ? 'onAccent' : accent, nodeId: node.id, role: 'node-icon' });
  items.push(...text.items);
  return { items, height };
}

function boxHeight(ctx, node, width) {
  const { pad } = ctx.density;
  return pad + ICON_SIZE + ICON_GAP + nodeText(ctx, node, { x: 0, y: 0, width: width - 2 * pad, anchor: 'middle', labelLines: 3, detailLines: 3 }).height + pad;
}

// Every tree layout ends the same way: connectors first (behind the boxes), then the boxes.
function renderTree(spec, ctx, { width, head, placements, connectors }) {
  const items = [...head.items];
  for (const points of connectors) {
    const d = `M${points.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join('L')}`;
    items.push(pathItem(d, points, { stroke: 'stroke', strokeWidth: 2 }));
  }
  const nodes = {};
  let bottom = head.bottom;
  for (const { node, x, y } of placements) {
    const isRoot = node.parent == null;
    const accent = accentFor(spec, node.id);
    const fill = isRoot ? accent : boxFill(node, accent);
    const onFill = isRoot || node.emphasis;
    const box = nodeBox(ctx, node, { x, y, width: BOX_WIDTH, fill, accent, onFill });
    items.push(...box.items);
    nodes[node.id] = { x, y, w: BOX_WIDTH, h: box.height };
    bottom = Math.max(bottom, y + box.height);
  }
  return finishScene({ width, items, nodes, bottom });
}

function levelNodesOf(spec, depths) {
  const levels = [];
  for (const node of spec.nodes) {
    const depth = depths.get(node.id);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(node.id);
  }
  for (let index = 0; index < levels.length; index += 1) if (!levels[index]) levels[index] = [];
  return levels;
}

// Compact org-chart: a level wider than COMPACT_WIDTH stacks its children as vertical lists
// under their parent (an elbow from the parent down a spine on the left of the list), so the
// level grows downwards instead of sideways.
function layoutCompact(spec, ctx, levels, heights, depths) {
  const { gap } = ctx.density;
  const children = new Map(spec.nodes.map((node) => [node.id, childrenOf(spec, node.id).map((child) => child.id)]));
  const isWide = (depth) => (levels[depth] ?? []).length > COMPACT_WIDTH;
  const maxDepth = levels.length - 1;

  const localX = new Map();
  let cursor = 0;
  for (const root of roots(spec)) {
    localX.set(root.id, cursor);
    cursor += BOX_WIDTH + gap * 1.5;
  }
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    for (const parent of levels[depth - 1]) {
      const kids = children.get(parent) ?? [];
      if (kids.length === 0) continue;
      if (isWide(depth)) {
        for (const kid of kids) localX.set(kid, localX.get(parent) + SPINE_OFFSET);
      } else {
        const total = kids.length * BOX_WIDTH + gap * (kids.length - 1);
        const start = localX.get(parent) + BOX_WIDTH / 2 - total / 2;
        kids.forEach((kid, index) => localX.set(kid, start + index * (BOX_WIDTH + gap)));
      }
    }
  }

  const xs = [...localX.values()];
  const minX = Math.min(...xs);
  const span = Math.max(...xs) + BOX_WIDTH - minX;
  const contentW = Math.max(CONTENT_WIDTH, span);
  const width = Math.max(CANVAS_WIDTH, contentW + 2 * MARGIN);
  const shift = MARGIN + (contentW - span) / 2 - minX;

  const levelHeights = levels.map((ids) => Math.max(0, ...ids.map((id) => heights.get(id))));
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    if (!isWide(depth)) continue;
    let tallest = 0;
    for (const parent of levels[depth - 1]) {
      const kids = children.get(parent) ?? [];
      if (kids.length === 0) continue;
      tallest = Math.max(tallest, kids.reduce((sum, kid) => sum + heights.get(kid), 0) + gap * (kids.length - 1));
    }
    levelHeights[depth] = tallest;
  }

  const head = titleBlock(spec, ctx, { width });
  const top = new Map();
  let cursorY = head.bottom;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (depth === 0 || !isWide(depth)) {
      for (const id of levels[depth]) top.set(id, cursorY);
    } else {
      for (const parent of levels[depth - 1]) {
        let y = cursorY;
        for (const kid of children.get(parent) ?? []) {
          top.set(kid, y);
          y += heights.get(kid) + gap;
        }
      }
    }
    cursorY += levelHeights[depth] + gap * 1.6;
  }

  const connectors = [];
  for (const node of spec.nodes) {
    if (node.parent == null) continue;
    const parentX = localX.get(node.parent) + shift;
    const parentBottom = top.get(node.parent) + heights.get(node.parent);
    const childX = localX.get(node.id) + shift;
    const childTop = top.get(node.id);
    if (isWide(depths.get(node.id))) {
      const spineX = parentX + SPINE_X;
      const spineTop = parentBottom + gap * 0.5;
      connectors.push([
        { x: parentX + BOX_WIDTH / 2, y: parentBottom },
        { x: parentX + BOX_WIDTH / 2, y: spineTop },
        { x: spineX, y: spineTop },
        { x: spineX, y: childTop + heights.get(node.id) / 2 },
        { x: childX, y: childTop + heights.get(node.id) / 2 },
      ]);
    } else {
      const mid = parentBottom + (childTop - parentBottom) / 2;
      connectors.push([
        { x: parentX + BOX_WIDTH / 2, y: parentBottom },
        { x: parentX + BOX_WIDTH / 2, y: mid },
        { x: childX + BOX_WIDTH / 2, y: mid },
        { x: childX + BOX_WIDTH / 2, y: childTop },
      ]);
    }
  }

  const placements = spec.nodes.map((node) => ({ node, x: localX.get(node.id) + shift, y: top.get(node.id) }));
  const bottom = cursorY - gap * 1.6;
  return renderTree(spec, ctx, { width, head, placements, connectors });
}

// Classic top-down tree: children spread horizontally under their parent.
function layoutNormal(spec, ctx, heights, depths) {
  const { gap } = ctx.density;
  const maxDepth = Math.max(0, ...depths.values());
  const levelHeights = [];
  for (const node of spec.nodes) {
    const depth = depths.get(node.id);
    levelHeights[depth] = Math.max(levelHeights[depth] ?? 0, heights.get(node.id));
  }

  const widths = new Map();
  const subtreeWidth = (id) => {
    if (widths.has(id)) return widths.get(id);
    const kids = childrenOf(spec, id);
    let value = BOX_WIDTH;
    if (kids.length > 0) {
      value = Math.max(BOX_WIDTH, kids.reduce((sum, kid) => sum + subtreeWidth(kid.id), 0) + gap * (kids.length - 1));
    }
    widths.set(id, value);
    return value;
  };
  const rootList = roots(spec);
  const forestWidth = rootList.length > 0
    ? rootList.reduce((sum, root) => sum + subtreeWidth(root.id), 0) + gap * 1.5 * (rootList.length - 1)
    : 0;
  const contentW = Math.max(CONTENT_WIDTH, forestWidth);
  const width = Math.max(CANVAS_WIDTH, contentW + 2 * MARGIN);
  const head = titleBlock(spec, ctx, { width });

  const levelTop = [];
  let cursorY = head.bottom;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    levelTop[depth] = cursorY;
    cursorY += (levelHeights[depth] ?? 0) + gap * 1.6;
  }

  const left = new Map();
  const place = (id, spanLeft) => {
    const kids = childrenOf(spec, id);
    const span = widths.get(id);
    if (kids.length === 0) {
      left.set(id, spanLeft + (span - BOX_WIDTH) / 2);
      return;
    }
    const childrenTotal = kids.reduce((sum, kid) => sum + widths.get(kid.id), 0) + gap * (kids.length - 1);
    const childLeft = spanLeft + (span - childrenTotal) / 2;
    left.set(id, childLeft + childrenTotal / 2 - BOX_WIDTH / 2);
    let cursorX = childLeft;
    for (const kid of kids) {
      place(kid.id, cursorX);
      cursorX += widths.get(kid.id) + gap;
    }
  };
  let forestCursor = MARGIN + (contentW - forestWidth) / 2;
  for (const root of rootList) {
    place(root.id, forestCursor);
    forestCursor += widths.get(root.id) + gap * 1.5;
  }

  const connectors = [];
  for (const node of spec.nodes) {
    if (node.parent == null) continue;
    const parentBottom = levelTop[depths.get(node.parent)] + heights.get(node.parent);
    const parentX = left.get(node.parent) + BOX_WIDTH / 2;
    const childTop = levelTop[depths.get(node.id)];
    const childX = left.get(node.id) + BOX_WIDTH / 2;
    const mid = parentBottom + (childTop - parentBottom) / 2;
    connectors.push([
      { x: parentX, y: parentBottom },
      { x: parentX, y: mid },
      { x: childX, y: mid },
      { x: childX, y: childTop },
    ]);
  }

  const placements = spec.nodes.map((node) => ({ node, x: left.get(node.id), y: levelTop[depths.get(node.id)] }));
  return renderTree(spec, ctx, { width, head, placements, connectors });
}

export default {
  id: 'tree',
  kind: 'hierarchy',
  label: 'Cây phân cấp',
  minNodes: 3,
  maxNodes: 15,
  uses: { parent: true, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const heights = new Map(spec.nodes.map((node) => [node.id, boxHeight(ctx, node, BOX_WIDTH)]));
    const depths = new Map(spec.nodes.map((node) => [node.id, depthOf(spec, node.id)]));
    const levels = levelNodesOf(spec, depths);
    const widest = Math.max(0, ...levels.map((ids) => ids.length));
    return widest > COMPACT_WIDTH
      ? layoutCompact(spec, ctx, levels, heights, depths)
      : layoutNormal(spec, ctx, heights, depths);
  },
};
