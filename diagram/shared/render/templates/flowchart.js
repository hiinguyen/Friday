import dagre from '@dagrejs/dagre';
import { CANVAS_WIDTH, CONTENT_WIDTH, MARGIN, titleBlock, nodeText, slotFor, boxFill, arrowHead, pathItem, textItem, finishScene } from '../kit.js';

const BOX_WIDTH = 180;
const ICON_SIZE = 22;
const ICON_GAP = 6;
const CHAIN_COLUMNS = 4;
// A band holds at most four dagre ranks; extra ranks stack in a new band below.
const BAND_RANKS = 4;
// Normalised 16:9 export frame. The layout whose scene fits it at the largest scale wins.
const FRAME = { width: 16, height: 9 };

function fitScale(scene) {
  return Math.min(FRAME.width / scene.width, FRAME.height / scene.height);
}

function bestScene(candidates) {
  return candidates.reduce((best, scene) => (fitScale(scene) > fitScale(best) ? scene : best));
}

function implicitChain(nodes) {
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i += 1) edges.push({ from: nodes[i].id, to: nodes[i + 1].id, label: '' });
  return edges;
}

// Returns the node ids in chain order when the graph is a simple path: connected,
// every node has at most one incoming and one outgoing edge, and every node is visited.
// An empty edge list is the implicit chain in array order. Otherwise null.
function chainOrder(nodes, edges) {
  const ids = nodes.map((node) => node.id);
  if (ids.length <= 1) return ids;
  if (edges.length === 0) return ids;
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, 0]));
  const next = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to) || edge.from === edge.to) return null;
    incoming.set(edge.to, incoming.get(edge.to) + 1);
    outgoing.set(edge.from, outgoing.get(edge.from) + 1);
    next.set(edge.from, edge.to);
  }
  for (const id of ids) if (incoming.get(id) > 1 || outgoing.get(id) > 1) return null;
  const starts = ids.filter((id) => incoming.get(id) === 0);
  const ends = ids.filter((id) => outgoing.get(id) === 0);
  if (starts.length !== 1 || ends.length !== 1) return null;
  const order = [];
  const seen = new Set();
  let current = starts[0];
  while (current !== undefined) {
    if (seen.has(current)) return null;
    seen.add(current);
    order.push(current);
    current = next.get(current);
  }
  return order.length === ids.length ? order : null;
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

// Serpentine layout for a simple chain: rows of up to four boxes, alternating
// left-to-right and right-to-left, with horizontal arrows inside a row and one
// vertical arrow from the end of a row to the start of the next.
function layoutChain(spec, ctx, order) {
  const { gap } = ctx.density;
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));
  const heights = new Map(spec.nodes.map((node) => [node.id, boxHeight(ctx, node, BOX_WIDTH)]));
  const labels = new Map(spec.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge.label]));
  const columns = Math.min(CHAIN_COLUMNS, order.length);
  const gridWidth = columns * BOX_WIDTH + (columns - 1) * gap;
  const width = Math.max(CANVAS_WIDTH, gridWidth + 2 * MARGIN);
  const head = titleBlock(spec, ctx, { width });
  const items = [...head.items];
  const nodes = {};
  const boxes = new Map();
  const rowOf = new Map();
  const verticalGap = gap * 2;
  const offsetX = width / 2 - gridWidth / 2;
  let cursor = head.bottom;
  const rowCount = Math.ceil(order.length / columns);
  for (let row = 0; row < rowCount; row += 1) {
    const slice = order.slice(row * columns, (row + 1) * columns);
    const rowHeight = Math.max(...slice.map((id) => heights.get(id)));
    slice.forEach((id, index) => {
      const column = row % 2 === 0 ? index : columns - 1 - index;
      const x = offsetX + column * (BOX_WIDTH + gap);
      const y = cursor + (rowHeight - heights.get(id)) / 2;
      boxes.set(id, { x, y, w: BOX_WIDTH, h: heights.get(id) });
      rowOf.set(id, row);
    });
    cursor += rowHeight + verticalGap;
  }

  for (let index = 0; index < order.length - 1; index += 1) {
    const from = order[index];
    const to = order[index + 1];
    const a = boxes.get(from);
    const b = boxes.get(to);
    let start;
    let end;
    let angle;
    if (rowOf.get(from) === rowOf.get(to)) {
      if (a.x <= b.x) {
        start = { x: a.x + a.w, y: a.y + a.h / 2 };
        end = { x: b.x, y: b.y + b.h / 2 };
        angle = 0;
      } else {
        start = { x: a.x, y: a.y + a.h / 2 };
        end = { x: b.x + b.w, y: b.y + b.h / 2 };
        angle = Math.PI;
      }
    } else {
      start = { x: a.x + a.w / 2, y: a.y + a.h };
      end = { x: b.x + b.w / 2, y: b.y };
      angle = Math.PI / 2;
    }
    const tipX = end.x - 2 * Math.cos(angle);
    const tipY = end.y - 2 * Math.sin(angle);
    items.push(pathItem(`M${start.x.toFixed(2)} ${start.y.toFixed(2)}L${tipX.toFixed(2)} ${tipY.toFixed(2)}`, [start, { x: tipX, y: tipY }], { stroke: 'stroke', strokeWidth: 2 }));
    const label = labels.get(`${from}\u0000${to}`);
    if (label) {
      const text = textItem(ctx, label, { x: tipX, y: tipY - 8, width: 120, style: 'small', maxLines: 2, anchor: 'middle', fill: 'mutedText' });
      if (text.item) {
        const measured = Math.max(...text.item.lines.map((line) => ctx.fontSet.measure(line, text.item.size, text.item.weight)));
        items.push({ type: 'rect', x: tipX - measured / 2 - 4, y: text.item.y - 2, w: measured + 8, h: text.height + 4, fill: 'background', stroke: 'none', role: 'decoration' });
        items.push(text.item);
      }
    }
    items.push(arrowHead(tipX, tipY, angle));
  }

  for (const id of order) {
    const node = byId.get(id);
    const box = boxes.get(id);
    const accent = node.color ?? slotFor(order.indexOf(id));
    const rendered = nodeBox(ctx, node, { x: box.x, y: box.y, width: BOX_WIDTH, fill: boxFill(node, accent), accent, onFill: node.emphasis });
    items.push(...rendered.items);
    nodes[node.id] = { x: box.x, y: box.y, w: BOX_WIDTH, h: rendered.height };
  }

  return finishScene({ width, items, nodes, bottom: cursor - verticalGap });
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

function edgeLabelItems(ctx, label, mid, items) {
  if (!label) return;
  const text = textItem(ctx, label, { x: mid.x, y: mid.y - 8, width: 120, style: 'small', maxLines: 2, anchor: 'middle', fill: 'mutedText' });
  if (!text.item) return;
  const measured = Math.max(...text.item.lines.map((line) => ctx.fontSet.measure(line, text.item.size, text.item.weight)));
  items.push({ type: 'rect', x: mid.x - measured / 2 - 4, y: text.item.y - 2, w: measured + 8, h: text.height + 4, fill: 'background', stroke: 'none', role: 'decoration' });
  items.push(text.item);
}

// Plain dagre layout, used as one candidate (LR and TB are tried).
function layoutDagre(spec, ctx, edges, rankdir) {
  const { gap } = ctx.density;
  const sizes = new Map(spec.nodes.map((node) => [node.id, boxHeight(ctx, node, BOX_WIDTH)]));
  const graph = buildGraph(spec.nodes, edges, rankdir, gap, sizes);
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
      edgeLabelItems(ctx, edge.label, mid, items);
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
}

// Banded layout: dagre's LR ranks split into consecutive bands of at most BAND_RANKS ranks.
// Each band lays its ranks left to right; bands stack top to bottom. Edges that leave a
// column run orthogonally through the gap between bands, so nothing crosses a box.
function layoutBanded(spec, ctx, edges) {
  const { gap } = ctx.density;
  const bandGap = gap * 2;
  const sizes = new Map(spec.nodes.map((node) => [node.id, boxHeight(ctx, node, BOX_WIDTH)]));
  const graph = buildGraph(spec.nodes, edges, 'LR', gap, sizes);
  const rawRankOf = new Map(spec.nodes.map((node) => [node.id, graph.node(node.id).rank]));
  // dagre leaves gaps between rank numbers; normalise them to 0..k-1 so bands and columns are tight.
  const orderedRanks = [...new Set(rawRankOf.values())].sort((a, b) => a - b);
  const rankIndex = new Map(orderedRanks.map((rank, index) => [rank, index]));
  const rankOf = new Map(spec.nodes.map((node) => [node.id, rankIndex.get(rawRankOf.get(node.id))]));
  const maxRank = Math.max(0, ...rankOf.values());

  const bands = [];
  for (let start = 0; start <= maxRank; start += BAND_RANKS) {
    const end = Math.min(maxRank, start + BAND_RANKS - 1);
    const ranks = [];
    for (let rank = start; rank <= end; rank += 1) {
      const ids = spec.nodes.filter((node) => rankOf.get(node.id) === rank).map((node) => node.id);
      const height = ids.length === 0 ? 0 : ids.reduce((sum, id) => sum + sizes.get(id), 0) + gap * (ids.length - 1);
      ranks.push({ rank, ids, height });
    }
    const height = Math.max(0, ...ranks.map((entry) => entry.height));
    const used = ranks.filter((entry) => entry.ids.length > 0);
    const columns = used.length === 0 ? 0 : used[used.length - 1].rank - start + 1;
    const width = columns === 0 ? 0 : columns * BOX_WIDTH + (columns - 1) * gap;
    bands.push({ start, ranks, height, width });
  }

  const contentW = Math.max(CONTENT_WIDTH, ...bands.map((band) => band.width));
  const width = Math.max(CANVAS_WIDTH, contentW + 2 * MARGIN);
  const head = titleBlock(spec, ctx, { width });
  const items = [...head.items];

  const boxes = new Map();
  const bandOf = new Map();
  let cursor = head.bottom;
  bands.forEach((band, index) => {
    band.top = cursor;
    band.bottom = cursor + band.height;
    const left = MARGIN + (contentW - band.width) / 2;
    for (const rank of band.ranks) {
      let y = cursor + (band.height - rank.height) / 2;
      for (const id of rank.ids) {
        boxes.set(id, { x: left + (rank.rank - band.start) * (BOX_WIDTH + gap), y, w: BOX_WIDTH, h: sizes.get(id) });
        bandOf.set(id, index);
        y += sizes.get(id) + gap;
      }
    }
    cursor += band.height + bandGap;
  });
  const bottom = cursor - bandGap;

  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b) continue;
    const ba = bandOf.get(edge.from);
    const bb = bandOf.get(edge.to);
    const sx = a.x + BOX_WIDTH / 2;
    const tx = b.x + BOX_WIDTH / 2;
    let points;
    if (ba === bb) {
      const rankA = rankOf.get(edge.from);
      const rankB = rankOf.get(edge.to);
      if (Math.abs(rankA - rankB) === 1) {
        points = a.x < b.x
          ? [{ x: a.x + BOX_WIDTH, y: a.y + a.h / 2 }, { x: b.x, y: b.y + b.h / 2 }]
          : [{ x: a.x, y: a.y + a.h / 2 }, { x: b.x + BOX_WIDTH, y: b.y + b.h / 2 }];
      } else {
        const channelY = bands[ba].bottom + bandGap * 0.35;
        points = [{ x: sx, y: a.y + a.h }, { x: sx, y: channelY }, { x: tx, y: channelY }, { x: tx, y: b.y + b.h }];
      }
    } else if (ba < bb) {
      const channelY = bands[ba].bottom + bandGap / 2;
      points = [{ x: sx, y: a.y + a.h }, { x: sx, y: channelY }, { x: tx, y: channelY }, { x: tx, y: b.y }];
    } else {
      const channelY = bands[ba].top - bandGap / 2;
      points = [{ x: sx, y: a.y }, { x: sx, y: channelY }, { x: tx, y: channelY }, { x: tx, y: b.y + b.h }];
    }
    const clean = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    const last = clean[clean.length - 1];
    const prev = clean[clean.length - 2];
    const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
    const tip = { x: last.x - 2 * Math.cos(angle), y: last.y - 2 * Math.sin(angle) };
    const line = [...clean.slice(0, -1), tip];
    const d = `M${line.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join('L')}`;
    items.push(pathItem(d, line, { stroke: 'stroke', strokeWidth: 2 }));
    if (edge.label) {
      const middle = clean.length === 2
        ? { x: (clean[0].x + clean[1].x) / 2, y: (clean[0].y + clean[1].y) / 2 }
        : { x: (clean[1].x + clean[2].x) / 2, y: (clean[1].y + clean[2].y) / 2 };
      edgeLabelItems(ctx, edge.label, middle, items);
    }
    items.push(arrowHead(tip.x, tip.y, angle));
  }

  const nodes = {};
  spec.nodes.forEach((node, index) => {
    const box = boxes.get(node.id);
    const accent = node.color ?? slotFor(index);
    const rendered = nodeBox(ctx, node, { x: box.x, y: box.y, width: BOX_WIDTH, fill: boxFill(node, accent), accent, onFill: node.emphasis });
    items.push(...rendered.items);
    nodes[node.id] = { x: box.x, y: box.y, w: BOX_WIDTH, h: rendered.height };
  });

  return finishScene({ width, items, nodes, bottom });
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
    const chain = chainOrder(spec.nodes, spec.edges);
    if (chain) return layoutChain(spec, ctx, chain);
    const edges = spec.edges.length > 0 ? spec.edges : implicitChain(spec.nodes);
    return bestScene([
      layoutDagre(spec, ctx, edges, 'LR'),
      layoutDagre(spec, ctx, edges, 'TB'),
      layoutBanded(spec, ctx, edges),
    ]);
  },
};
