import { wrapText } from './text.js';
import { roots, childrenOf } from '../spec/tree.js';

export const CANVAS_WIDTH = 960;
export const MARGIN = 40;
export const CONTENT_WIDTH = CANVAS_WIDTH - 2 * MARGIN;
export const TINT = 0.14;
export const TYPE = {
  title: { size: 28, weight: 700, lineHeight: 1.25 },
  subtitle: { size: 16, weight: 400, lineHeight: 1.4 },
  label: { size: 17, weight: 600, lineHeight: 1.3 },
  detail: { size: 13.5, weight: 400, lineHeight: 1.4 },
  small: { size: 12.5, weight: 500, lineHeight: 1.3 },
  value: { size: 22, weight: 700, lineHeight: 1.2 },
};
const LABEL_DETAIL_GAP = 4;

// One wrapped text item. Returns { item: null, height: 0 } for empty text.
export function textItem(ctx, text, { x, y, width, style, maxLines, anchor = 'start', fill = 'text', nodeId, role }) {
  const type = TYPE[style];
  const wrapped = wrapText(ctx.fontSet, text, { size: type.size, weight: type.weight, maxWidth: width, maxLines });
  if (wrapped.lines.length === 0) return { item: null, height: 0 };
  const lineHeight = wrapped.size * type.lineHeight;
  const height = wrapped.lines.length * lineHeight;
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  return {
    item: { type: 'text', x, y, lines: wrapped.lines, size: wrapped.size, weight: type.weight, lineHeight, anchor, fill, box: { x: left, y, w: width, h: height }, nodeId, role },
    height,
  };
}

// Label + detail of a node stacked from y. onFill: the text sits on a solid accent.
export function nodeText(ctx, node, { x, y, width, anchor = 'start', labelLines = 2, detailLines = 3, onFill = false, labelStyle = 'label' }) {
  const label = textItem(ctx, node.label, { x, y, width, style: labelStyle, maxLines: labelLines, anchor, fill: onFill ? 'onAccent' : 'text', nodeId: node.id, role: 'node-label' });
  const detailY = y + label.height + (label.height > 0 ? LABEL_DETAIL_GAP : 0);
  const detail = detailLines > 0
    ? textItem(ctx, node.detail, { x, y: detailY, width, style: 'detail', maxLines: detailLines, anchor, fill: onFill ? 'onAccent' : 'mutedText', nodeId: node.id, role: 'node-detail' })
    : { item: null, height: 0 };
  const items = [label.item, detail.item].filter(Boolean);
  const height = detail.height > 0 ? detailY - y + detail.height : label.height;
  return { items, height };
}

// Centred title and subtitle. bottom already includes the gap before the diagram.
export function titleBlock(spec, ctx, { y = MARGIN, width = CANVAS_WIDTH } = {}) {
  const textWidth = Math.min(width - 2 * MARGIN, 760);
  const title = textItem(ctx, spec.title, { x: width / 2, y, width: textWidth, style: 'title', maxLines: 2, anchor: 'middle', role: 'title' });
  const subY = y + title.height + (title.height > 0 ? 8 : 0);
  const subtitle = textItem(ctx, spec.subtitle, { x: width / 2, y: subY, width: textWidth, style: 'subtitle', maxLines: 2, anchor: 'middle', fill: 'mutedText', role: 'subtitle' });
  const used = subtitle.height > 0 ? subY - y + subtitle.height : title.height;
  return { items: [title.item, subtitle.item].filter(Boolean), bottom: used > 0 ? y + used + ctx.density.gap * 1.2 : y };
}

export function slotFor(index) {
  return `accent${(index % 6) + 1}`;
}

// Colour slot of a node in hierarchical templates: an explicit colour on the node or an
// ancestor wins; otherwise each branch under a single root gets its own slot.
export function accentFor(spec, nodeId) {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const chain = [];
  for (let node = byId.get(nodeId); node; node = node.parent ? byId.get(node.parent) : null) {
    if (node.color) return node.color;
    chain.push(node);
  }
  const top = chain[chain.length - 1];
  const rootList = roots(spec);
  if (rootList.length === 1 && chain.length >= 2) {
    const branch = chain[chain.length - 2];
    return slotFor(childrenOf(spec, top.id).findIndex((n) => n.id === branch.id));
  }
  return slotFor(Math.max(0, rootList.findIndex((n) => n.id === top.id)));
}

// Emphasised nodes are solid accent boxes, the rest are light tints.
export function boxFill(node, accent) {
  return node.emphasis ? accent : { token: accent, mix: TINT };
}

// Round icon badge: a solid circle with the icon on top. For a node drawn on a solid
// accent box (emphasis) call it as badge(node, 'onAccent', { ..., iconColor: accent }).
export function badge(node, fill, { cx, cy, r, iconColor = 'onAccent' }) {
  const size = r * 1.1;
  return [
    { type: 'circle', cx, cy, r, fill, stroke: 'none', nodeId: node.id, role: 'node-icon' },
    { type: 'icon', name: node.icon, x: cx - size / 2, y: cy - size / 2, size, color: iconColor, nodeId: node.id, role: 'node-icon' },
  ];
}

export function pathItem(d, points, { fill = 'none', stroke = 'stroke', strokeWidth = 2, dash = false, nodeId, role = 'connector' } = {}) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { type: 'path', d, fill, stroke, strokeWidth, dash, bounds: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, nodeId, role };
}

// Filled triangle with its tip at (x, y) pointing along angle (radians).
export function arrowHead(x, y, angle, { size = 10, paint = 'stroke' } = {}) {
  const spread = (150 * Math.PI) / 180;
  const a = { x: x + size * Math.cos(angle + spread), y: y + size * Math.sin(angle + spread) };
  const b = { x: x + size * Math.cos(angle - spread), y: y + size * Math.sin(angle - spread) };
  const d = `M${x.toFixed(2)} ${y.toFixed(2)}L${a.x.toFixed(2)} ${a.y.toFixed(2)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}Z`;
  return pathItem(d, [{ x, y }, a, b], { fill: paint, stroke: 'none', strokeWidth: 0, role: 'connector' });
}

export function unionBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

export function finishScene({ width = CANVAS_WIDTH, items, nodes, bottom }) {
  return { width: Math.ceil(width), height: Math.ceil(bottom + MARGIN), items, nodes };
}
