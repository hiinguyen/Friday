import dagre from '@dagrejs/dagre';
import { CANVAS_WIDTH, CONTENT_WIDTH, MARGIN, titleBlock, nodeText, slotFor, boxFill, arrowHead, pathItem, textItem, finishScene } from '../kit.js';

const BOX_WIDTH = 180;
const ICON_SIZE = 22;
const ICON_GAP = 6;

function implicitChain(nodes) {
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i += 1) edges.push({ from: nodes[i].id, to: nodes[i + 1].id, label: '' });
  return edges;
}

function boxHeight(ctx, node, width) {
  const { pad } = ctx.density;
  return pad + ICON_SIZE + ICON_GAP + nodeText(ctx, node, { x: 0, y: 0, width: width - 2 * pad, anchor: 'middle', labelLines: 3, detailLines: 3 }).height + pad;
}

function nodeBox(ctx, node, { x, y, width, fill, accent, onFill = false }) {
  const { pad } = ctx.density;
  const items = [];
  const text = nodeText(ctx, node, { x: x + width / 2, y: y + pad + ICON_SIZE + ICON_GAP, width: width - 2 * pad, anchor: 'middle', onFill, labelLines: 3, detailLines: 3 });
  const height = pad + ICON_SIZE + ICON_GAP + text.height + pad;
  items.push({ type: 'rect', x, y, w: width, h: height, radius: 'theme', fill, stroke: 'none', shadow: true, nodeId: node.id, role: 'node-box' });
  items.push({ type: 'icon', name: node.icon, x: x + width / 2 - ICON_SIZE / 2, y: y + pad, size: ICON_SIZE, color: onFill ? 'onAccent' : accent, nodeId: node.id, role: 'node-icon' });
  items.push(...text.items);
  return { items, height };
}

function buildGraph(nodes, edges, rankdir, gap, sizes) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, nodesep: gap, ranksep: gap * 2, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) g.setNode(node.id, { width: BOX_WIDTH, height: sizes.get(node.id) });
  for (const edge of edges) {
    if (edge.from !== edge.to) g.setEdge(edge.from, edge.to);
  }
  dagre.layout(g);
  return g;
}

export default {
  id: 'flowchart',
  kind: 'relationship',
  label: 'Lưu đồ',
  minNodes: 3,
  maxNodes: 12,
  uses: { parent: false, edges: true, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap } = ctx.density;
    const edges = spec.edges.length > 0 ? spec.edges : implicitChain(spec.nodes);
    const sizes = new Map(spec.nodes.map((node) => [node.id, boxHeight(ctx, node, BOX_WIDTH)]));
    let graph = buildGraph(spec.nodes, edges, 'LR', gap, sizes);
    if (graph.graph().width > CONTENT_WIDTH) graph = buildGraph(spec.nodes, edges, 'TB', gap, sizes);
    const graphW = graph.graph().width;
    const contentW = Math.max(CONTENT_WIDTH, graphW);
    const width = Math.max(CANVAS_WIDTH, contentW + 2 * MARGIN);
    const head = titleBlock(spec, ctx, { width });
    const items = [...head.items];
    const nodes = {};
    const offsetX = MARGIN + (contentW - graphW) / 2;
    const offsetY = head.bottom;
    let bottom = head.bottom;

    const placed = spec.nodes.map((node, index) => {
      const gNode = graph.node(node.id);
      return { node, x: gNode.x - BOX_WIDTH / 2 + offsetX, y: gNode.y - sizes.get(node.id) / 2 + offsetY, index };
    });

    for (const edge of edges) {
      if (edge.from === edge.to) continue;
      const ge = graph.edge(edge.from, edge.to);
      if (!ge || !ge.points || ge.points.length < 2) continue;
      const pts = ge.points.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY }));
      const lastIndex = pts.length - 1;
      const last = pts[lastIndex];
      const prev = pts[lastIndex - 1];
      const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
      const end = { x: last.x - 2 * Math.cos(angle), y: last.y - 2 * Math.sin(angle) };
      pts[lastIndex] = end;
      const d = `M${pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L')}`;
      items.push(pathItem(d, pts, { stroke: 'stroke', strokeWidth: 2 }));
      if (edge.label) {
        const mid = pts[Math.floor(pts.length / 2)];
        const label = textItem(ctx, edge.label, { x: mid.x, y: mid.y - 8, width: 120, style: 'small', maxLines: 2, anchor: 'middle', fill: 'mutedText' });
        if (label.item) {
          const measured = Math.max(...label.item.lines.map((line) => ctx.fontSet.measure(line, label.item.size, label.item.weight)));
          items.push({ type: 'rect', x: mid.x - measured / 2 - 4, y: label.item.y - 2, w: measured + 8, h: label.height + 4, fill: 'background', stroke: 'none', role: 'decoration' });
          items.push(label.item);
        }
      }
      items.push(arrowHead(end.x, end.y, angle));
    }

    for (const { node, x, y, index } of placed) {
      const accent = node.color ?? slotFor(index);
      const box = nodeBox(ctx, node, { x, y, width: BOX_WIDTH, fill: boxFill(node, accent), accent, onFill: node.emphasis });
      items.push(...box.items);
      nodes[node.id] = { x, y, w: BOX_WIDTH, h: box.height };
      bottom = Math.max(bottom, y + box.height);
    }

    return finishScene({ width, items, nodes, bottom });
  },
};
