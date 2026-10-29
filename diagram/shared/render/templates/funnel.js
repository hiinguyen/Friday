import { CONTENT_WIDTH, MARGIN, titleBlock, textItem, slotFor, pathItem, finishScene, unionBox } from '../kit.js';

const BAND_GAP = 6;

export default {
  id: 'funnel',
  kind: 'proportion',
  label: 'Phễu',
  minNodes: 3,
  maxNodes: 6,
  uses: { parent: false, edges: false, value: true },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap, pad } = ctx.density;
    const head = titleBlock(spec, ctx);
    const items = [...head.items];
    const nodes = {};
    const funnelW = 0.58 * CONTENT_WIDTH;
    const minW = funnelW * 0.38;
    const maxW = funnelW;
    const centreX = MARGIN + funnelW / 2;
    const detailX = MARGIN + funnelW + gap;
    const detailW = MARGIN + CONTENT_WIDTH - detailX;
    const n = spec.nodes.length;
    const format = new Intl.NumberFormat(spec.lang || 'vi');

    const bands = spec.nodes.map((node, index) => {
      const topW = maxW - (index * (maxW - minW)) / n;
      const bottomW = maxW - ((index + 1) * (maxW - minW)) / n;
      const value = node.value != null ? format.format(node.value) : null;
      const valueHeight = value != null ? textItem(ctx, value, { x: 0, y: 0, width: maxW, style: 'value', maxLines: 1, anchor: 'middle' }).height + 4 : 0;
      const labelHeight = textItem(ctx, node.label, { x: 0, y: 0, width: bottomW - 2 * pad, style: 'label', maxLines: 2, anchor: 'middle' }).height;
      return { node, index, topW, bottomW, value, valueHeight, labelHeight, height: Math.max(64, pad + valueHeight + labelHeight + pad) };
    });

    let y = head.bottom;
    let bottom = head.bottom;
    for (const band of bands) {
      const { node, index, topW, bottomW, height } = band;
      const accent = node.color ?? slotFor(index);
      const lTop = centreX - topW / 2;
      const rTop = centreX + topW / 2;
      const lBottom = centreX - bottomW / 2;
      const rBottom = centreX + bottomW / 2;
      const path = pathItem(
        `M${lTop} ${y}H${rTop}L${rBottom} ${y + height}H${lBottom}Z`,
        [{ x: lTop, y }, { x: rTop, y }, { x: rBottom, y: y + height }, { x: lBottom, y: y + height }],
        { fill: accent, stroke: 'none', strokeWidth: 0, nodeId: node.id, role: 'node-box' },
      );
      items.push(path);

      let contentY = y + (height - (band.valueHeight + band.labelHeight)) / 2;
      if (band.value != null) {
        const valueItem = textItem(ctx, band.value, { x: centreX, y: contentY, width: maxW, style: 'value', maxLines: 1, anchor: 'middle', fill: 'onAccent', nodeId: node.id, role: 'node-value' });
        if (valueItem.item) items.push(valueItem.item);
        contentY += valueItem.height + 4;
      }
      const label = textItem(ctx, node.label, { x: centreX, y: contentY, width: bottomW - 2 * pad, style: 'label', maxLines: 2, anchor: 'middle', fill: 'onAccent', nodeId: node.id, role: 'node-label' });
      if (label.item) items.push(label.item);

      const boxes = [path.bounds];
      const detail = textItem(ctx, node.detail, { x: detailX, y: 0, width: detailW, style: 'detail', maxLines: 4, fill: 'mutedText', nodeId: node.id, role: 'node-detail' });
      if (detail.item) {
        const detailY = y + (height - detail.height) / 2;
        const detailItem = { ...detail.item, y: detailY, box: { ...detail.item.box, y: detailY } };
        items.push(detailItem);
        const x0 = centreX + (topW + bottomW) / 4;
        const y0 = y + height / 2;
        const x1 = detailX;
        const y1 = detailY + detail.height / 2;
        items.push(pathItem(`M${x0} ${y0}L${x1} ${y1}`, [{ x: x0, y: y0 }, { x: x1, y: y1 }], { stroke: 'stroke', strokeWidth: 1.5, dash: true, nodeId: node.id, role: 'connector' }));
        boxes.push(detailItem.box);
      }
      nodes[node.id] = unionBox(boxes);
      bottom = y + height;
      y += height + BAND_GAP;
    }

    return finishScene({ items, nodes, bottom });
  },
};
