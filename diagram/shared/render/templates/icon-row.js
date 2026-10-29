import { CONTENT_WIDTH, MARGIN, titleBlock, nodeText, slotFor, badge, pathItem, finishScene } from '../kit.js';

export default {
  id: 'icon-row',
  kind: 'list',
  label: 'Hàng biểu tượng',
  minNodes: 2,
  maxNodes: 6,
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
    const colW = (CONTENT_WIDTH - gap * (n - 1)) / n;
    const baseR = Math.min(44, colW / 2 - 4);
    const radii = spec.nodes.map((node) => (node.emphasis ? Math.min(baseR * 1.15, colW / 2 - 2) : baseR));
    const rMax = Math.max(...radii);
    const cy = head.bottom + rMax;
    const colStart = (i) => MARGIN + i * (colW + gap);
    const centreX = (i) => colStart(i) + colW / 2;
    if (n >= 2) {
      const d = `M${centreX(0)} ${cy}L${centreX(n - 1)} ${cy}`;
      items.push(pathItem(d, [{ x: centreX(0), y: cy }, { x: centreX(n - 1), y: cy }], { stroke: 'stroke', strokeWidth: 2, role: 'decoration' }));
    }
    let bottom = cy;
    spec.nodes.forEach((node, i) => {
      const accent = node.color ?? slotFor(i);
      const r = radii[i];
      const cx = centreX(i);
      items.push(...badge(node, accent, { cx, cy, r }));
      const text = nodeText(ctx, node, { x: cx, y: cy + rMax + pad, width: colW, anchor: 'middle', labelLines: 3, detailLines: 4 });
      items.push(...text.items);
      const top = cy - r;
      const textBottom = cy + rMax + pad + text.height;
      nodes[node.id] = { x: colStart(i), y: top, w: colW, h: textBottom - top };
      bottom = Math.max(bottom, textBottom);
    });
    return finishScene({ items, nodes, bottom });
  },
};
