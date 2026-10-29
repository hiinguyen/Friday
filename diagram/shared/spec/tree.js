function nodesOf(spec) {
  return spec && Array.isArray(spec.nodes) ? spec.nodes : [];
}

export function roots(spec) {
  return nodesOf(spec).filter((node) => node && node.parent == null);
}

export function childrenOf(spec, id) {
  return nodesOf(spec).filter((node) => node && node.parent === id);
}

export function depthOf(spec, id) {
  const byId = new Map(nodesOf(spec).map((node) => [node.id, node]));
  let node = byId.get(id);
  if (!node) return -1;
  const seen = new Set();
  let depth = 0;
  while (node && node.parent != null && !seen.has(node.id)) {
    seen.add(node.id);
    node = byId.get(node.parent);
    if (!node) break;
    depth += 1;
  }
  return depth;
}

export function descendantIds(spec, id) {
  const result = [];
  const visit = (parentId) => {
    for (const node of nodesOf(spec)) {
      if (node && node.parent === parentId) {
        result.push(node.id);
        visit(node.id);
      }
    }
  };
  visit(id);
  return result;
}

// Returns the id of a node that closes a parent cycle, or null when there is none.
export function findCycleNode(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.filter((node) => node && typeof node.id === 'string').map((node) => [node.id, node]));
  for (const start of list) {
    if (!start || typeof start.id !== 'string') continue;
    const seen = new Set();
    let current = start;
    while (current) {
      if (seen.has(current.id)) return current.id;
      seen.add(current.id);
      current = current.parent != null ? byId.get(current.parent) : null;
    }
  }
  return null;
}
