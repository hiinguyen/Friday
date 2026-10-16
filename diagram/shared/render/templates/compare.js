import { roots, childrenOf, descendantIds } from '../../spec/tree.js';
import { CONTENT_WIDTH, MARGIN, titleBlock, textItem, nodeText, accentFor, finishScene } from '../kit.js';

const HEADER_ICON = 22;
const CARD_ICON = 18;
const ICON_GAP = 6;
const CARD_PAD = 10;
const MAX_COLUMNS = 4;

function measureHeader(ctx, node, width) {
  const { pad } = ctx.density;
  const inner = width - 2 * pad;
  return {
    labelH: textItem(ctx, node.label, { x: 0, y: 0, width: inner, style: 'label', maxLines: 2, anchor: 'middle' }).height,
    detailH: textItem(ctx, node.detail, { x: 0, y: 0, width: inner, style: 'detail', maxLines: 3, anchor: 'middle' }).height,
  };
}

export default {
  id: 'compare',
  kind: 'comparison',
  label: 'So sánh',
  minNodes: 4,
  maxNodes: 16,
  uses: { parent: true, edges: false, value: false },
  accepts(spec) {
    const rootList = roots(spec);
    if (rootList.length >= 2 && rootList.length <= MAX_COLUMNS) return null;
    if (rootList.length === 1 && childrenOf(spec, rootList[0].id).length >= 2 && childrenOf(spec, rootList[0].id).length <= MAX_COLUMNS) return null;
    return 'Cần 2-4 nhóm để so sánh';
  },
  layout(spec, ctx) {
    const { gap, pad } = ctx.density;
    const rootList = roots(spec);
    const banner = rootList.length === 1 ? rootList[0] : null;
    const columns = banner ? childrenOf(spec, banner.id) : rootList;

    const chunks = [];
    for (let i = 0; i < columns.length; i += MAX_COLUMNS) chunks.push(columns.slice(i, i + MAX_COLUMNS));

    const items = [];
    const nodes = {};
    const head = titleBlock(spec, ctx, {});
    items.push(...head.items);
    let top = head.bottom;

    if (banner) {
      const inner = CONTENT_WIDTH - 2 * pad;
      const label = textItem(ctx, banner.label, { x: MARGIN + CONTENT_WIDTH / 2, y: top + pad, width: inner, style: 'label', maxLines: 2, anchor: 'middle', fill: 'onAccent', nodeId: banner.id, role: 'node-label' });
      const height = pad + Math.max(label.height, HEADER_ICON) + pad;
      items.push({ type: 'rect', x: MARGIN, y: top, w: CONTENT_WIDTH, h: height, radius: 'theme', fill: 'accent1', stroke: 'none', shadow: true, nodeId: banner.id, role: 'node-box' });
      if (label.item) items.push({ ...label.item, y: top + (height - label.height) / 2, box: { ...label.item.box, y: top + (height - label.height) / 2 } });
      nodes[banner.id] = { x: MARGIN, y: top, w: CONTENT_WIDTH, h: height };
      top = top + height + gap;
    }

    for (const chunk of chunks) {
      const cols = chunk.length;
      const colW = (CONTENT_WIDTH - gap * (cols - 1)) / cols;
      const metric = chunk.map((node) => measureHeader(ctx, node, colW));
      const maxLabelH = Math.max(0, ...metric.map((m) => m.labelH));
      const maxDetailH = Math.max(0, ...metric.map((m) => m.detailH));
      const headerH = pad + HEADER_ICON + ICON_GAP + maxLabelH + pad;
      const detailH = maxDetailH > 0 ? 4 + maxDetailH : 0;

      const rowNodes = chunk.map((node) => descendantIds(spec, node.id).map((id) => spec.nodes.find((n) => n.id === id)));
      const rowHeights = [];
      for (let r = 0; r < rowNodes.reduce((max, list) => Math.max(max, list.length), 0); r += 1) {
        let height = 0;
        for (const list of rowNodes) {
          if (r >= list.length) continue;
          const node = list[r];
          const textW = colW - 2 * pad - CARD_ICON - 8;
          const textH = nodeText(ctx, node, { x: 0, y: 0, width: textW, labelLines: 2, detailLines: 3 }).height;
          height = Math.max(height, Math.max(CARD_ICON, textH) + 2 * CARD_PAD);
        }
        rowHeights.push(height);
      }

      chunk.forEach((node, index) => {
        const accent = accentFor(spec, node.id);
        const x = MARGIN + index * (colW + gap);
        items.push({ type: 'rect', x, y: top, w: colW, h: headerH, radius: 'theme', fill: accent, stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
        items.push({ type: 'icon', name: node.icon, x: x + colW / 2 - HEADER_ICON / 2, y: top + pad, size: HEADER_ICON, color: 'onAccent', nodeId: node.id, role: 'node-icon' });
        const label = textItem(ctx, node.label, { x: x + colW / 2, y: top + pad + HEADER_ICON + ICON_GAP, width: colW - 2 * pad, style: 'label', maxLines: 2, anchor: 'middle', fill: 'onAccent', nodeId: node.id, role: 'node-label' });
        if (label.item) items.push(label.item);
        if (maxDetailH > 0) {
          const detail = textItem(ctx, node.detail, { x: x + colW / 2, y: top + headerH + 4, width: colW - 2 * pad, style: 'detail', maxLines: 3, anchor: 'middle', fill: 'mutedText', nodeId: node.id, role: 'node-detail' });
          if (detail.item) items.push(detail.item);
        }
        nodes[node.id] = { x, y: top, w: colW, h: headerH + detailH };
      });

      let rowY = top + headerH + detailH + gap / 2;
      for (let r = 0; r < rowHeights.length; r += 1) {
        const rowH = rowHeights[r];
        chunk.forEach((headerNode, index) => {
          const list = rowNodes[index];
          if (r >= list.length) return;
          const node = list[r];
          const x = MARGIN + index * (colW + gap);
          const accent = accentFor(spec, headerNode.id);
          items.push({ type: 'rect', x, y: rowY, w: colW, h: rowH, radius: 'theme', fill: { token: accent, mix: 0.14 }, stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
          const textX = x + pad + CARD_ICON + 8;
          const textW = colW - 2 * pad - CARD_ICON - 8;
          const text = nodeText(ctx, node, { x: textX, y: 0, width: textW, labelLines: 2, detailLines: 3 });
          const textY = rowY + (rowH - text.height) / 2;
          items.push({ type: 'icon', name: node.icon, x: x + pad, y: rowY + (rowH - CARD_ICON) / 2, size: CARD_ICON, color: accent, nodeId: node.id, role: 'node-icon' });
          for (const item of text.items) items.push({ ...item, y: item.y + textY, box: { ...item.box, y: item.y + textY } });
          nodes[node.id] = { x, y: rowY, w: colW, h: rowH };
        });
        rowY += rowH + gap / 2;
      }
      top = rowY - gap / 2 + gap;
    }

    return finishScene({ items, nodes, bottom: top - gap });
  },
};
