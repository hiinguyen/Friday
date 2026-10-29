import { CANVAS_WIDTH, CONTENT_WIDTH, MARGIN, titleBlock, nodeText, slotFor, boxFill, badge, finishScene } from '../kit.js';

const BADGE_RADIUS = 20;

function columnsFor(count) {
  if (count <= 3) return count;
  return count === 4 ? 2 : 3;
}

export default {
  id: 'cards',
  kind: 'list',
  label: 'Thẻ',
  minNodes: 2,
  maxNodes: 9,
  uses: { parent: false, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap, pad } = ctx.density;
    const head = titleBlock(spec, ctx);
    const items = [...head.items];
    const nodes = {};
    const count = spec.nodes.length;
    const columns = Math.max(1, columnsFor(count));
    const cardWidth = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
    const textWidth = cardWidth - 2 * pad;
    let y = head.bottom;
    for (let start = 0; start < count; start += columns) {
      const row = spec.nodes.slice(start, start + columns);
      const texts = row.map((node) => {
        const textTop = y + pad + BADGE_RADIUS * 2 + pad * 0.75;
        return nodeText(ctx, node, { x: 0, y: textTop, width: textWidth, onFill: node.emphasis, labelLines: 2, detailLines: 4 });
      });
      const rowHeight = Math.max(...texts.map((t) => pad + BADGE_RADIUS * 2 + pad * 0.75 + t.height + pad));
      const rowWidth = row.length * cardWidth + (row.length - 1) * gap;
      const left = MARGIN + (CONTENT_WIDTH - rowWidth) / 2;
      row.forEach((node, i) => {
        const index = start + i;
        const accent = node.color ?? slotFor(index);
        const x = left + i * (cardWidth + gap);
        items.push({ type: 'rect', x, y, w: cardWidth, h: rowHeight, radius: 'theme', fill: boxFill(node, accent), stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
        const centre = { cx: x + pad + BADGE_RADIUS, cy: y + pad + BADGE_RADIUS, r: BADGE_RADIUS };
        items.push(...(node.emphasis ? badge(node, 'onAccent', { ...centre, iconColor: accent }) : badge(node, accent, centre)));
        for (const item of texts[i].items) items.push({ ...item, x: x + pad, box: { ...item.box, x: x + pad } });
        nodes[node.id] = { x, y, w: cardWidth, h: rowHeight };
      });
      y += rowHeight + gap;
    }
    return finishScene({ width: CANVAS_WIDTH, items, nodes, bottom: y - gap });
  },
};
