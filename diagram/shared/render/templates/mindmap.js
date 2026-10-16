import { roots, childrenOf, depthOf, descendantIds } from '../../spec/tree.js';
import { CANVAS_WIDTH, MARGIN, titleBlock, textItem, nodeText, accentFor, boxFill, pathItem, finishScene } from '../kit.js';

const CENTRE_WIDTH = 170;
const BRANCH_WIDTH = 150;
const LEAF_WIDTH = 150;
const CENTRE_GAP = 48;
const LEAF_GAP = 40;
const INDENT = 12;
const ICON_SIZE = 22;
const ICON_GAP = 6;

function nodeBox(ctx, node, { x, y, width, fill, accent, onFill = false, stroke = 'none', strokeWidth }) {
  const { pad } = ctx.density;
  const items = [];
  const text = nodeText(ctx, node, { x: x + width / 2, y: y + pad + ICON_SIZE + ICON_GAP, width: width - 2 * pad, anchor: 'middle', onFill, labelLines: 2, detailLines: 2 });
  const height = pad + ICON_SIZE + ICON_GAP + text.height + pad;
  items.push({ type: 'rect', x, y, w: width, h: height, radius: 'theme', fill, stroke, strokeWidth, shadow: true, nodeId: node.id, role: 'node-box' });
  items.push({ type: 'icon', name: node.icon, x: x + width / 2 - ICON_SIZE / 2, y: y + pad, size: ICON_SIZE, color: onFill ? 'onAccent' : accent, nodeId: node.id, role: 'node-icon' });
  items.push(...text.items);
  return { items, height };
}

function boxHeight(ctx, node, width) {
  const { pad } = ctx.density;
  return pad + ICON_SIZE + ICON_GAP + nodeText(ctx, node, { x: 0, y: 0, width: width - 2 * pad, anchor: 'middle', labelLines: 2, detailLines: 2 }).height + pad;
}

function bezier(ctx, x0, y0, x1, y1, stroke, strokeWidth) {
  const dx = x1 - x0;
  const d = `M${x0.toFixed(2)} ${y0.toFixed(2)}C${(x0 + dx / 2).toFixed(2)} ${y0.toFixed(2)},${(x1 - dx / 2).toFixed(2)} ${y1.toFixed(2)},${x1.toFixed(2)} ${y1.toFixed(2)}`;
  return pathItem(d, [{ x: x0, y: y0 }, { x: x0 + dx / 2, y: y0 }, { x: x1 - dx / 2, y: y1 }, { x: x1, y: y1 }], { stroke, strokeWidth });
}

export default {
  id: 'mindmap',
  kind: 'hierarchy',
  label: 'Sơ đồ tư duy',
  minNodes: 3,
  maxNodes: 15,
  uses: { parent: true, edges: false, value: false },
  accepts() {
    return null;
  },
  layout(spec, ctx) {
    const { gap, pad } = ctx.density;
    const byId = new Map(spec.nodes.map((node) => [node.id, node]));
    const rootList = roots(spec);
    const centreNode = rootList.length === 1 ? rootList[0] : null;
    const centreLabel = centreNode ? centreNode.label : spec.title || '…';
    const branches = centreNode ? childrenOf(spec, centreNode.id) : rootList;
    const baseDepth = centreNode ? depthOf(spec, centreNode.id) : -1;

    const half = Math.ceil(branches.length / 2);
    const sides = { right: branches.slice(0, half), left: branches.slice(half) };

    const blockFor = (branch) => {
      const leaves = descendantIds(spec, branch.id).map((id) => {
        const depth = depthOf(spec, id) - baseDepth;
        const indent = INDENT * Math.max(0, depth - 2);
        return { node: byId.get(id), indent, width: LEAF_WIDTH - indent };
      });
      const leafHeights = leaves.map((leaf) => boxHeight(ctx, leaf.node, leaf.width));
      const leavesTotal = leafHeights.reduce((sum, value) => sum + value, 0) + (gap / 2) * Math.max(0, leaves.length - 1);
      const branchHeight = boxHeight(ctx, branch, BRANCH_WIDTH);
      return { branch, leaves, leafHeights, branchHeight, height: Math.max(branchHeight, leavesTotal) };
    };
    const build = (list) => list.map(blockFor);
    const rightBlocks = build(sides.right);
    const leftBlocks = build(sides.left);

    const extent = (blocks) => {
      if (blocks.length === 0) return 0;
      const hasLeaves = blocks.some((block) => block.leaves.length > 0);
      return CENTRE_GAP + BRANCH_WIDTH + (hasLeaves ? LEAF_GAP + LEAF_WIDTH : 0);
    };
    const outer = Math.max(extent(rightBlocks), extent(leftBlocks));
    const contentW = CENTRE_WIDTH + 2 * outer;
    const width = Math.max(CANVAS_WIDTH, contentW + 2 * MARGIN);
    const head = titleBlock(spec, ctx, { width });
    const items = [...head.items];
    const nodes = {};

    const centreTextProbe = textItem(ctx, centreLabel, { x: 0, y: 0, width: CENTRE_WIDTH - 2 * pad, style: 'label', maxLines: 2, anchor: 'middle', fill: 'onAccent', nodeId: centreNode ? centreNode.id : undefined, role: 'node-label' });
    const centreH = pad + centreTextProbe.height + pad;

    const sideHeight = (blocks) => (blocks.length === 0 ? 0 : blocks.reduce((sum, block) => sum + block.height, 0) + gap * (blocks.length - 1));
    const rightHeight = sideHeight(rightBlocks);
    const leftHeight = sideHeight(leftBlocks);
    const contentHeight = Math.max(rightHeight, leftHeight, centreH);
    const contentTop = head.bottom;

    const centreX = width / 2;
    const centreLeft = centreX - CENTRE_WIDTH / 2;
    const centreRight = centreX + CENTRE_WIDTH / 2;
    const centreY = contentTop + (contentHeight - centreH) / 2;

    const layoutSide = (blocks, side) => {
      if (blocks.length === 0) return;
      const totalHeight = sideHeight(blocks);
      let cursor = contentTop + (contentHeight - totalHeight) / 2;
      for (const block of blocks) {
        const blockTop = cursor;
        const branchY = blockTop + (block.height - block.branchHeight) / 2;
        const accent = accentFor(spec, block.branch.id);
        const branchX = side === 'right' ? centreRight + CENTRE_GAP : centreLeft - CENTRE_GAP - BRANCH_WIDTH;
        const branchFacing = side === 'right' ? branchX : branchX + BRANCH_WIDTH;
        const branchOuter = side === 'right' ? branchX + BRANCH_WIDTH : branchX;
        const centreEdge = side === 'right' ? centreRight : centreLeft;
        items.push(bezier(ctx, centreEdge, centreY + centreH / 2, branchFacing, branchY + block.branchHeight / 2, accent, 2.5));

        let leafCursor = blockTop;
        block.leaves.forEach((leaf, index) => {
          const leafY = leafCursor;
          const leafHeight = block.leafHeights[index];
          const leafColumnLeft = side === 'right' ? centreRight + CENTRE_GAP + BRANCH_WIDTH + LEAF_GAP : centreLeft - CENTRE_GAP - BRANCH_WIDTH - LEAF_GAP - LEAF_WIDTH;
          const leafX = side === 'right' ? leafColumnLeft + leaf.indent : leafColumnLeft;
          const leafEdge = side === 'right' ? leafX : leafX + leaf.width;
          items.push(bezier(ctx, branchOuter, branchY + block.branchHeight / 2, leafEdge, leafY + leafHeight / 2, accent, 1.5));
          leafCursor += leafHeight + gap / 2;
        });
        cursor += block.height + gap;
      }
    };
    layoutSide(rightBlocks, 'right');
    layoutSide(leftBlocks, 'left');

    items.push({ type: 'rect', x: centreLeft, y: centreY, w: CENTRE_WIDTH, h: centreH, radius: 'pill', fill: 'accent1', stroke: 'none', shadow: true, nodeId: centreNode ? centreNode.id : undefined, role: 'node-box' });
    const centreText = textItem(ctx, centreLabel, { x: centreX, y: centreY + pad, width: CENTRE_WIDTH - 2 * pad, style: 'label', maxLines: 2, anchor: 'middle', fill: 'onAccent', nodeId: centreNode ? centreNode.id : undefined, role: 'node-label' });
    if (centreText.item) items.push(centreText.item);
    if (centreNode) nodes[centreNode.id] = { x: centreLeft, y: centreY, w: CENTRE_WIDTH, h: centreH };

    const renderSide = (blocks, side) => {
      if (blocks.length === 0) return;
      const totalHeight = sideHeight(blocks);
      let cursor = contentTop + (contentHeight - totalHeight) / 2;
      for (const block of blocks) {
        const blockTop = cursor;
        const branchY = blockTop + (block.height - block.branchHeight) / 2;
        const accent = accentFor(spec, block.branch.id);
        const branchX = side === 'right' ? centreRight + CENTRE_GAP : centreLeft - CENTRE_GAP - BRANCH_WIDTH;
        const box = nodeBox(ctx, block.branch, { x: branchX, y: branchY, width: BRANCH_WIDTH, fill: boxFill(block.branch, accent), accent, onFill: block.branch.emphasis });
        items.push(...box.items);
        nodes[block.branch.id] = { x: branchX, y: branchY, w: BRANCH_WIDTH, h: block.branchHeight };

        let leafCursor = blockTop;
        block.leaves.forEach((leaf, index) => {
          const leafY = leafCursor;
          const leafHeight = block.leafHeights[index];
          const leafColumnLeft = side === 'right' ? centreRight + CENTRE_GAP + BRANCH_WIDTH + LEAF_GAP : centreLeft - CENTRE_GAP - BRANCH_WIDTH - LEAF_GAP - LEAF_WIDTH;
          const leafX = side === 'right' ? leafColumnLeft + leaf.indent : leafColumnLeft;
          const leafAccent = accentFor(spec, leaf.node.id);
          const leafBox = nodeBox(ctx, leaf.node, { x: leafX, y: leafY, width: leaf.width, fill: 'background', accent: leafAccent, stroke: leafAccent, strokeWidth: 1.5 });
          items.push(...leafBox.items);
          nodes[leaf.node.id] = { x: leafX, y: leafY, w: leaf.width, h: leafHeight };
          leafCursor += leafHeight + gap / 2;
        });
        cursor += block.height + gap;
      }
    };
    renderSide(rightBlocks, 'right');
    renderSide(leftBlocks, 'left');

    return finishScene({ width, items, nodes, bottom: contentTop + contentHeight });
  },
};
