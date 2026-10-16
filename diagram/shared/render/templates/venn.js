import { roots, childrenOf } from '../../spec/tree.js';
import { CANVAS_WIDTH, MARGIN, titleBlock, textItem, nodeText, slotFor, finishScene, unionBox } from '../kit.js';

const RADIUS = 140;
const LIST_WIDTH = 190;
const BOTTOM_LIST_WIDTH = 300;
const DOT = 4;
const SHIFT = 0.45;

export default {
  id: 'venn',
  kind: 'relationship',
  label: 'Biểu đồ Venn',
  minNodes: 2,
  maxNodes: 12,
  uses: { parent: true, edges: false, value: false },
  accepts(spec) {
    const rootList = roots(spec);
    return rootList.length === 2 || rootList.length === 3 ? null : 'Cần 2 hoặc 3 nhóm giao nhau';
  },
  layout(spec, ctx) {
    const { gap } = ctx.density;
    const byId = new Map(spec.nodes.map((node) => [node.id, node]));
    const rootList = roots(spec);
    const circleNodes = rootList.slice(0, 3);
    const circleCount = circleNodes.length;
    const three = circleCount === 3;
    const pointsFor = circleNodes.map((circle) => childrenOf(spec, circle.id).map((node) => node.id));
    if (rootList.length > 3 && pointsFor.length > 0) {
      for (const extra of rootList.slice(3)) pointsFor[pointsFor.length - 1].push(extra.id);
    }

    const measureList = (ids, listWidth, anchor) => ids.reduce((sum, id, index) => (
      sum + nodeText(ctx, byId.get(id), { x: 0, y: 0, width: listWidth, anchor, labelLines: 2, detailLines: 2 }).height + (index > 0 ? gap / 2 : 0)
    ), 0);

    const sideOverhang = (ids) => 0.62 * RADIUS + RADIUS + (ids.length > 0 ? gap + LIST_WIDTH : 0);
    let overhang = RADIUS;
    if (circleCount === 3) {
      overhang = Math.max(sideOverhang(pointsFor[0]), sideOverhang(pointsFor[1]));
      if (pointsFor[2].length > 0) overhang = Math.max(overhang, BOTTOM_LIST_WIDTH / 2);
    } else if (circleCount === 2) {
      overhang = Math.max(sideOverhang(pointsFor[0]), sideOverhang(pointsFor[1]));
    }
    const width = Math.max(CANVAS_WIDTH, 2 * overhang);
    const head = titleBlock(spec, ctx, { width });
    const items = [...head.items];
    const nodes = {};
    const cx = width / 2;
    const cy = head.bottom + RADIUS + (three ? 0.36 * RADIUS : 0);
    const centres = circleCount === 3
      ? [{ x: cx - 0.62 * RADIUS, y: cy - 0.36 * RADIUS }, { x: cx + 0.62 * RADIUS, y: cy - 0.36 * RADIUS }, { x: cx, y: cy + 0.72 * RADIUS }]
      : circleCount === 2
        ? [{ x: cx - 0.62 * RADIUS, y: cy }, { x: cx + 0.62 * RADIUS, y: cy }]
        : [{ x: cx, y: cy }];
    let bottom = head.bottom;

    const placeList = (ids, { anchor, x, listWidth, startY, accent }) => {
      let cursor = startY;
      for (const id of ids) {
        const node = byId.get(id);
        const text = nodeText(ctx, node, { x, y: cursor, width: listWidth, anchor, labelLines: 2, detailLines: 2, nodeId: node.id });
        items.push(...text.items);
        const box = unionBox(text.items.map((item) => item.box));
        nodes[node.id] = box;
        if (text.items.length > 0) {
          const first = text.items[0];
          const measured = ctx.fontSet.measure(first.lines[0], first.size, first.weight);
          const dotX = anchor === 'end' ? x + 8 : anchor === 'middle' ? x - measured / 2 - 8 : x - 8;
          items.push({ type: 'circle', cx: dotX, cy: first.y + first.lineHeight / 2, r: DOT, fill: accent, stroke: 'none', nodeId: node.id, role: 'decoration' });
        }
        bottom = Math.max(bottom, box.y + box.h);
        cursor += text.height + gap / 2;
      }
    };

    circleNodes.forEach((node, index) => {
      const accent = slotFor(index);
      const centre = centres[index];
      items.push({ type: 'circle', cx: centre.x, cy: centre.y, r: RADIUS, fill: { token: accent, opacity: 0.3 }, stroke: accent, strokeWidth: 2, nodeId: node.id, role: 'node-box' });
      const dx = centre.x - cx;
      const dy = centre.y - cy;
      const length = Math.hypot(dx, dy) || 1;
      const labelX = centre.x + (dx / length) * SHIFT * RADIUS;
      const labelY = centre.y + (dy / length) * SHIFT * RADIUS;
      const probe = textItem(ctx, node.label, { x: labelX, y: 0, width: 0.9 * RADIUS, style: 'label', maxLines: 2, anchor: 'middle', fill: 'text', nodeId: node.id, role: 'node-label' });
      if (probe.item) {
        const y = labelY - probe.height / 2;
        const item = { ...probe.item, y, box: { ...probe.item.box, y } };
        items.push(item);
        nodes[node.id] = item.box;
      } else {
        nodes[node.id] = { x: labelX - 0.45 * RADIUS, y: labelY - 10, w: 0.9 * RADIUS, h: 20 };
      }
      bottom = Math.max(bottom, centre.y + RADIUS);
    });

    if (circleCount === 3) {
      placeList(pointsFor[0], { anchor: 'end', x: centres[0].x - RADIUS - gap, listWidth: LIST_WIDTH, startY: cy - measureList(pointsFor[0], LIST_WIDTH, 'end') / 2, dotSide: 'end', accent: slotFor(0) });
      placeList(pointsFor[1], { anchor: 'start', x: centres[1].x + RADIUS + gap, listWidth: LIST_WIDTH, startY: cy - measureList(pointsFor[1], LIST_WIDTH, 'start') / 2, dotSide: 'start', accent: slotFor(1) });
      placeList(pointsFor[2], { anchor: 'middle', x: cx, listWidth: BOTTOM_LIST_WIDTH, startY: centres[2].y + RADIUS + gap, dotSide: 'start', accent: slotFor(2) });
    } else if (circleCount === 2) {
      placeList(pointsFor[0], { anchor: 'end', x: centres[0].x - RADIUS - gap, listWidth: LIST_WIDTH, startY: cy - measureList(pointsFor[0], LIST_WIDTH, 'end') / 2, dotSide: 'end', accent: slotFor(0) });
      placeList(pointsFor[1], { anchor: 'start', x: centres[1].x + RADIUS + gap, listWidth: LIST_WIDTH, startY: cy - measureList(pointsFor[1], LIST_WIDTH, 'start') / 2, dotSide: 'start', accent: slotFor(1) });
    } else if (circleCount === 1) {
      placeList(pointsFor[0], { anchor: 'middle', x: cx, listWidth: BOTTOM_LIST_WIDTH, startY: centres[0].y + RADIUS + gap, dotSide: 'start', accent: slotFor(0) });
    }

    return finishScene({ width, items, nodes, bottom });
  },
};
