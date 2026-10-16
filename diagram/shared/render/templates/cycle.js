import { CANVAS_WIDTH, MARGIN, titleBlock, nodeText, slotFor, boxFill, pathItem, arrowHead, finishScene } from '../kit.js';

const BOX_WIDTH = 170;
const ICON_SIZE = 22;
const ICON_GAP = 6;
const MAX_RADIUS = 800;
const BOX_PADDING = 8;
const MIN_ARC_LENGTH = 24;
const BISECTION_STEPS = 48;

function nodeBox(ctx, node, { x, y, width, fill, accent, onFill = false }) {
  const { pad } = ctx.density;
  const items = [];
  const text = nodeText(ctx, node, { x: x + width / 2, y: y + pad + ICON_SIZE + ICON_GAP, width: width - 2 * pad, anchor: 'middle', onFill, labelLines: 2, detailLines: 2 });
  const height = pad + ICON_SIZE + ICON_GAP + text.height + pad;
  items.push({ type: 'rect', x, y, w: width, h: height, radius: 'theme', fill, stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
  items.push({ type: 'icon', name: node.icon, x: x + width / 2 - ICON_SIZE / 2, y: y + pad, size: ICON_SIZE, color: onFill ? 'onAccent' : accent, nodeId: node.id, role: 'node-icon' });
  items.push(...text.items);
  return { items, height };
}

function boxHeight(ctx, node, width) {
  const { pad } = ctx.density;
  return pad + ICON_SIZE + ICON_GAP + nodeText(ctx, node, { x: 0, y: 0, width: width - 2 * pad, anchor: 'middle', labelLines: 2, detailLines: 2 }).height + pad;
}

function positionsFor(n, cx, cy, r) {
  const positions = [];
  for (let i = 0; i < n; i += 1) {
    const theta = -Math.PI / 2 + (2 * Math.PI * i) / n;
    positions.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta), theta });
  }
  return positions;
}

function boxesClear(positions, boxW, boxH, gap) {
  const span = Math.hypot(boxW, boxH);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      if (Math.hypot(dx, dy) < span + gap / 2) return false;
    }
  }
  return true;
}

function paddedBox(position, boxW, boxH) {
  return {
    x: position.x - boxW / 2 - BOX_PADDING,
    y: position.y - boxH / 2 - BOX_PADDING,
    w: boxW + 2 * BOX_PADDING,
    h: boxH + 2 * BOX_PADDING,
  };
}

function insideBox(box, radius, angle) {
  const px = radius * Math.cos(angle);
  const py = radius * Math.sin(angle);
  return px > box.x && px < box.x + box.w && py > box.y && py < box.y + box.h;
}

// Boundary angle where the circle of `radius` around the origin leaves `box`, walking
// from `from` (inside the box) toward `toward`. Bisection because a circle and a
// rectangle can intersect up to eight times.
function leaveAngle(box, radius, from, toward) {
  let lo = from;
  let hi = toward;
  if (insideBox(box, radius, hi)) hi = from + (toward > from ? Math.PI : -Math.PI);
  for (let i = 0; i < BISECTION_STEPS; i += 1) {
    const mid = (lo + hi) / 2;
    if (insideBox(box, radius, mid)) lo = mid; else hi = mid;
  }
  return hi;
}

// One span per consecutive pair: leaves box i, enters box i + 1. Angles are measured
// around the circle centre (the boxes are translated to the origin here).
function arcSpans(n, boxW, boxH, radius) {
  const step = (2 * Math.PI) / n;
  const base = -Math.PI / 2;
  const positions = positionsFor(n, 0, 0, radius);
  const spans = [];
  for (let i = 0; i < n; i += 1) {
    const next = i + 1;
    const nextAngle = base + step * next;
    const from = leaveAngle(paddedBox(positions[i], boxW, boxH), radius, base + step * i, base + step * (i + 1));
    const to = leaveAngle(paddedBox(positions[next % n], boxW, boxH), radius, nextAngle, nextAngle - step);
    spans.push({ from, to, length: radius * (to - from) });
  }
  return spans;
}

function arcsVisible(n, boxW, boxH, radius) {
  return arcSpans(n, boxW, boxH, radius).every((span) => span.length >= MIN_ARC_LENGTH);
}

export default {
  id: 'cycle',
  kind: 'cycle',
  label: 'Vòng lặp',
  minNodes: 3,
  maxNodes: 8,
  uses: { parent: false, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap } = ctx.density;
    const n = spec.nodes.length;
    const boxH = Math.max(...spec.nodes.map((node) => boxHeight(ctx, node, BOX_WIDTH)));
    const initial = n >= 2 ? (BOX_WIDTH + gap) / (2 * Math.sin(Math.PI / n)) : 140;
    let radius = Math.min(MAX_RADIUS, Math.max(140, initial));
    while (radius < MAX_RADIUS
      && (!boxesClear(positionsFor(n, 0, 0, radius), BOX_WIDTH, boxH, gap) || !arcsVisible(n, BOX_WIDTH, boxH, radius))) {
      radius += 10;
    }

    const contentW = 2 * radius + BOX_WIDTH;
    const width = Math.max(CANVAS_WIDTH, contentW + 2 * MARGIN);
    const head = titleBlock(spec, ctx, { width });
    const items = [...head.items];
    const nodes = {};
    const cx = width / 2;
    const cy = head.bottom + radius + boxH / 2;
    const positions = positionsFor(n, cx, cy, radius);

    if (radius > 120) {
      const inner = Math.min(radius - boxH / 2 - 20, 70);
      if (inner > 0) {
        const iconSize = Math.min(inner * 1.1, 48);
        items.push({ type: 'circle', cx, cy, r: inner, fill: { token: 'accent1', mix: 0.14 }, stroke: 'none', role: 'decoration' });
        items.push({ type: 'icon', name: 'refresh-cw', x: cx - iconSize / 2, y: cy - iconSize / 2, size: iconSize, color: 'accent1', role: 'decoration' });
      }
    }

    if (n >= 2) {
      for (const span of arcSpans(n, BOX_WIDTH, boxH, radius)) {
        const x0 = cx + radius * Math.cos(span.from);
        const y0 = cy + radius * Math.sin(span.from);
        const x1 = cx + radius * Math.cos(span.to);
        const y1 = cy + radius * Math.sin(span.to);
        const d = `M${x0.toFixed(2)} ${y0.toFixed(2)}A${radius} ${radius} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
        const arc = pathItem(d, [{ x: x0, y: y0 }, { x: x1, y: y1 }], { stroke: 'stroke', strokeWidth: 2.5 });
        arc.bounds = { x: cx - radius, y: cy - radius, w: 2 * radius, h: 2 * radius };
        items.push(arc);
        items.push(arrowHead(x1, y1, span.to + Math.PI / 2));
      }
    }

    spec.nodes.forEach((node, i) => {
      const accent = node.color ?? slotFor(i);
      const x = positions[i].x - BOX_WIDTH / 2;
      const y = positions[i].y - boxH / 2;
      const box = nodeBox(ctx, node, { x, y, width: BOX_WIDTH, fill: boxFill(node, accent), accent, onFill: node.emphasis });
      items.push(...box.items);
      nodes[node.id] = { x, y, w: BOX_WIDTH, h: boxH };
    });

    const bottom = cy + radius + boxH / 2;
    return finishScene({ width, items, nodes, bottom });
  },
};
