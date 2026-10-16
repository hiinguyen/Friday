import { CONTENT_WIDTH, MARGIN, titleBlock, textItem, slotFor, pathItem, finishScene } from '../kit.js';

const NOTCH = 18;
const ICON_SIZE = 24;
const ICON_GAP = 6;

export default {
  id: 'steps',
  kind: 'sequence',
  label: 'Các bước',
  minNodes: 3,
  maxNodes: 6,
  uses: { parent: false, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { pad } = ctx.density;
    const head = titleBlock(spec, ctx);
    const top = head.bottom;
    const items = [...head.items];
    const nodes = {};
    const n = spec.nodes.length;
    const w = (CONTENT_WIDTH + (n - 1) * (NOTCH - 4)) / n;
    const startX = (i) => MARGIN + i * (w - NOTCH + 4);
    const innerLeft = (i) => startX(i) + (i === 0 ? pad : NOTCH + pad * 0.5);
    const innerWidth = (i) => startX(i) + w - NOTCH - pad * 0.5 - innerLeft(i);

    const labels = spec.nodes.map((node, i) => textItem(ctx, node.label, { x: innerLeft(i), y: 0, width: innerWidth(i), style: 'label', maxLines: 3, fill: 'onAccent', nodeId: node.id, role: 'node-label' }));
    const h = Math.max(...labels.map((label) => pad + ICON_SIZE + ICON_GAP + label.height + pad));

    let bottom = top + h;
    spec.nodes.forEach((node, i) => {
      const accent = node.color ?? slotFor(i);
      const x = startX(i);
      const d = i === 0
        ? `M${x} ${top}H${x + w - NOTCH}L${x + w} ${top + h / 2}L${x + w - NOTCH} ${top + h}H${x}Z`
        : `M${x} ${top}H${x + w - NOTCH}L${x + w} ${top + h / 2}L${x + w - NOTCH} ${top + h}H${x}L${x + NOTCH} ${top + h / 2}Z`;
      const points = i === 0
        ? [{ x, y: top }, { x: x + w - NOTCH, y: top }, { x: x + w, y: top + h / 2 }, { x: x + w - NOTCH, y: top + h }, { x, y: top + h }]
        : [{ x, y: top }, { x: x + w - NOTCH, y: top }, { x: x + w, y: top + h / 2 }, { x: x + w - NOTCH, y: top + h }, { x, y: top + h }, { x: x + NOTCH, y: top + h / 2 }];
      items.push(pathItem(d, points, { fill: accent, stroke: node.emphasis ? 'text' : 'none', strokeWidth: node.emphasis ? 3 : 0, nodeId: node.id, role: 'node-box' }));
      items.push({ type: 'icon', name: node.icon, x: innerLeft(i), y: top + pad, size: ICON_SIZE, color: 'onAccent', nodeId: node.id, role: 'node-icon' });
      const labelY = top + pad + ICON_SIZE + ICON_GAP;
      const label = labels[i];
      if (label.item) items.push({ ...label.item, y: labelY, box: { ...label.item.box, y: labelY } });
      const detailY = top + h + pad * 0.75;
      const detail = textItem(ctx, node.detail, { x: x + (i === 0 ? 0 : NOTCH / 2), y: detailY, width: w - NOTCH, style: 'detail', maxLines: 5, fill: 'mutedText', nodeId: node.id, role: 'node-detail' });
      if (detail.item) items.push(detail.item);
      const left = x + (i === 0 ? 0 : NOTCH / 2);
      const right = x + w - NOTCH / 2;
      const boxH = detail.height > 0 ? h + pad * 0.75 + detail.height : h;
      nodes[node.id] = { x: left, y: top, w: right - left, h: boxH };
      bottom = Math.max(bottom, detail.height > 0 ? detailY + detail.height : top + h);
    });

    return finishScene({ items, nodes, bottom });
  },
};
