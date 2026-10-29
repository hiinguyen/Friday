import { CONTENT_WIDTH, MARGIN, titleBlock, nodeText, slotFor, boxFill, pathItem, finishScene } from '../kit.js';

const ICON_SIZE = 24;
const AXIS_GAP = 36;
const DOT_RADIUS = 9;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export default {
  id: 'timeline',
  kind: 'sequence',
  label: 'Dòng thời gian',
  minNodes: 3,
  maxNodes: 8,
  uses: { parent: false, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap, pad } = ctx.density;
    const head = titleBlock(spec, ctx);
    const items = [...head.items];
    const nodes = {};
    const n = spec.nodes.length;
    const slotW = CONTENT_WIDTH / n;
    const cardW = Math.min(2 * slotW - gap, 240, slotW);
    const textWidth = cardW - 2 * pad;

    const cards = spec.nodes.map((node) => {
      const textHeight = nodeText(ctx, node, { x: 0, y: 0, width: textWidth, labelLines: 2, detailLines: 3 }).height;
      return { height: pad + ICON_SIZE + 8 + textHeight + pad };
    });
    const aboveH = Math.max(0, ...spec.nodes.map((_, i) => (i % 2 === 0 ? cards[i].height : 0)));
    const belowH = Math.max(0, ...spec.nodes.map((_, i) => (i % 2 === 1 ? cards[i].height : 0)));
    const axisY = head.bottom + aboveH + AXIS_GAP;

    items.push({ type: 'rect', x: MARGIN, y: axisY - 2, w: CONTENT_WIDTH, h: 4, radius: 'pill', fill: 'stroke', stroke: 'none', role: 'decoration' });

    spec.nodes.forEach((node, i) => {
      const accent = node.color ?? slotFor(i);
      const above = i % 2 === 0;
      const cx = MARGIN + slotW * (i + 0.5);
      const cardH = cards[i].height;
      const cardLeft = clamp(cx - cardW / 2, MARGIN, MARGIN + CONTENT_WIDTH - cardW);
      const cardTop = above ? axisY - AXIS_GAP - cardH : axisY + AXIS_GAP;
      const edgeY = above ? cardTop + cardH : cardTop;
      const d = `M${cx} ${axisY}L${cx} ${edgeY}`;
      items.push(pathItem(d, [{ x: cx, y: axisY }, { x: cx, y: edgeY }], { stroke: accent, strokeWidth: 2 }));
      items.push({ type: 'circle', cx, cy: axisY, r: DOT_RADIUS, fill: accent, stroke: 'background', strokeWidth: 3, role: 'decoration' });
      items.push({ type: 'rect', x: cardLeft, y: cardTop, w: cardW, h: cardH, radius: 'theme', fill: boxFill(node, accent), stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
      items.push({ type: 'icon', name: node.icon, x: cardLeft + pad, y: cardTop + pad, size: ICON_SIZE, color: accent, nodeId: node.id, role: 'node-icon' });
      const text = nodeText(ctx, node, { x: cardLeft + pad, y: cardTop + pad + ICON_SIZE + 8, width: textWidth, onFill: node.emphasis, labelLines: 2, detailLines: 3 });
      items.push(...text.items);
      nodes[node.id] = { x: cardLeft, y: cardTop, w: cardW, h: cardH };
    });

    const bottom = belowH > 0 ? axisY + AXIS_GAP + belowH : axisY + 20;
    return finishScene({ items, nodes, bottom });
  },
};
