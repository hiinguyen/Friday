import { roots, childrenOf, depthOf } from '../../spec/tree.js';
import { CANVAS_WIDTH, CONTENT_WIDTH, MARGIN, titleBlock, nodeText, accentFor, boxFill, pathItem, finishScene } from '../kit.js';

const BOX_WIDTH = 160;
const ICON_SIZE = 22;
const ICON_GAP = 6;

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
    const { gap } = ctx.density;
    const heights = new Map(spec.nodes.map((node) => [node.id, boxHeight(ctx, node, BOX_WIDTH)]));
    const depths = new Map(spec.nodes.map((node) => [node.id, depthOf(spec, node.id)]));
    const maxDepth = Math.max(0, ...depths.values());
    const levelHeights = [];
    for (const node of spec.nodes) {
      const d = depths.get(node.id);
      levelHeights[d] = Math.max(levelHeights[d] ?? 0, heights.get(node.id));
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
    const items = [...head.items];
    const nodes = {};

    const levelTop = [];
    let cursorY = head.bottom;
    for (let d = 0; d <= maxDepth; d += 1) {
      levelTop[d] = cursorY;
      cursorY += (levelHeights[d] ?? 0) + gap * 1.6;
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

    const byId = new Map(spec.nodes.map((node) => [node.id, node]));
    for (const node of spec.nodes) {
      if (node.parent == null) continue;
      const parent = byId.get(node.parent);
      const parentBottom = levelTop[depths.get(node.parent)] + heights.get(node.parent);
      const parentX = left.get(node.parent) + BOX_WIDTH / 2;
      const childTop = levelTop[depths.get(node.id)];
      const childX = left.get(node.id) + BOX_WIDTH / 2;
      const mid = parentBottom + (childTop - parentBottom) / 2;
      const d = `M${parentX} ${parentBottom}L${parentX} ${mid}L${childX} ${mid}L${childX} ${childTop}`;
      items.push(pathItem(d, [{ x: parentX, y: parentBottom }, { x: parentX, y: mid }, { x: childX, y: mid }, { x: childX, y: childTop }], { stroke: 'stroke', strokeWidth: 2 }));
    }

    let bottom = head.bottom;
    for (const node of spec.nodes) {
      const isRoot = node.parent == null;
      const accent = accentFor(spec, node.id);
      const x = left.get(node.id);
      const y = levelTop[depths.get(node.id)];
      const fill = isRoot ? accent : boxFill(node, accent);
      const onFill = isRoot || node.emphasis;
      const box = nodeBox(ctx, node, { x, y, width: BOX_WIDTH, fill, accent, onFill });
      items.push(...box.items);
      nodes[node.id] = { x, y, w: BOX_WIDTH, h: heights.get(node.id) };
      bottom = Math.max(bottom, y + heights.get(node.id));
    }

    return finishScene({ width, items, nodes, bottom });
  },
};
