import { CONTENT_WIDTH, MARGIN, titleBlock, nodeText, slotFor, pathItem, finishScene, unionBox } from '../kit.js';

const LAYER_GAP = 6;
const ICON_SIZE = 22;

export default {
  id: 'pyramid',
  kind: 'hierarchy',
  label: 'Kim tự tháp',
  minNodes: 3,
  maxNodes: 6,
  uses: { parent: false, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap } = ctx.density;
    const head = titleBlock(spec, ctx);
    const items = [...head.items];
    const nodes = {};
    const pyrW = 0.5 * CONTENT_WIDTH;
    const apexX = MARGIN + pyrW / 2;
    const top = head.bottom;
    const n = spec.nodes.length;
    const textX = MARGIN + pyrW + gap;
    const textW = MARGIN + CONTENT_WIDTH - textX;

    const heights = spec.nodes.map((node) => nodeText(ctx, node, { x: 0, y: 0, width: textW, labelLines: 2, detailLines: 3 }).height);
    const tallest = Math.max(0, ...heights);
    const layerH = Math.max(70, tallest + gap / 2);
    const base = top + n * (layerH + LAYER_GAP) - LAYER_GAP;
    const xAt = (y) => {
      const t = (y - top) / (base - top);
      return { left: apexX + (MARGIN - apexX) * t, right: apexX + (MARGIN + pyrW - apexX) * t };
    };

    let bottom = top;
    spec.nodes.forEach((node, index) => {
      const accent = node.color ?? slotFor(index);
      const layerTop = top + index * (layerH + LAYER_GAP);
      const layerBottom = layerTop + layerH;
      let d;
      let points;
      if (index === 0) {
        const edge = xAt(layerBottom);
        d = `M${apexX} ${layerTop}L${edge.right} ${layerBottom}L${edge.left} ${layerBottom}Z`;
        points = [{ x: apexX, y: layerTop }, { x: edge.right, y: layerBottom }, { x: edge.left, y: layerBottom }];
      } else {
        const upper = xAt(layerTop);
        const lower = xAt(layerBottom);
        d = `M${upper.left} ${layerTop}L${upper.right} ${layerTop}L${lower.right} ${layerBottom}L${lower.left} ${layerBottom}Z`;
        points = [{ x: upper.left, y: layerTop }, { x: upper.right, y: layerTop }, { x: lower.right, y: layerBottom }, { x: lower.left, y: layerBottom }];
      }
      const path = pathItem(d, points, { fill: accent, stroke: 'none', strokeWidth: 0, nodeId: node.id, role: 'node-box' });
      items.push(path);

      const midY = (layerTop + layerBottom) / 2;
      const midEdge = xAt(midY);
      const layerW = midEdge.right - midEdge.left;
      if (layerW >= 40) {
        const iconSize = Math.min(ICON_SIZE, layerW * 0.5);
        items.push({ type: 'icon', name: node.icon, x: apexX - iconSize / 2, y: midY - iconSize / 2, size: iconSize, color: 'onAccent', nodeId: node.id, role: 'node-icon' });
      }

      const textY = layerTop + (layerH - heights[index]) / 2;
      const text = nodeText(ctx, node, { x: textX, y: textY, width: textW, labelLines: 2, detailLines: 3 });
      items.push(...text.items);
      items.push(pathItem(`M${midEdge.right} ${midY}L${textX} ${textY + text.height / 2}`, [{ x: midEdge.right, y: midY }, { x: textX, y: textY + text.height / 2 }], { stroke: 'stroke', strokeWidth: 1.5, dash: true, nodeId: node.id, role: 'connector' }));

      const boxes = [path.bounds];
      const textBoxes = text.items.map((item) => item.box);
      if (textBoxes.length > 0) boxes.push(unionBox(textBoxes));
      nodes[node.id] = unionBox(boxes);
      bottom = Math.max(bottom, layerBottom);
    });

    return finishScene({ items, nodes, bottom });
  },
};
