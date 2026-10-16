const FIELD_LOCKS = ['label', 'detail', 'icon', 'color'];

export function applyLocks(edited, revised) {
  const next = structuredClone(revised);
  const locks = [...new Set([...(edited.locks ?? []), ...(revised.locks ?? [])])];
  if (locks.includes('title')) next.title = edited.title;
  if (locks.includes('subtitle')) next.subtitle = edited.subtitle;

  const editedById = new Map(edited.nodes.map((node) => [node.id, node]));
  const revisedById = new Map(next.nodes.map((node) => [node.id, node]));

  for (const [id, node] of revisedById) {
    const source = editedById.get(id);
    if (!source) continue;
    for (const field of FIELD_LOCKS) {
      if (locks.includes(`${id}.${field}`)) node[field] = source[field];
    }
  }

  const lockedNodeIds = new Set();
  for (const lock of locks) {
    const dot = lock.indexOf('.');
    if (dot > 0) {
      const id = lock.slice(0, dot);
      if (id !== 'nodes') lockedNodeIds.add(id);
    }
  }
  for (const id of lockedNodeIds) {
    if (revisedById.has(id)) continue;
    const source = editedById.get(id);
    if (!source) continue;
    const restored = structuredClone(source);
    next.nodes.push(restored);
    revisedById.set(id, restored);
  }

  if (locks.includes('nodes.order')) {
    const editedOrder = edited.nodes.map((node) => node.id);
    const ordered = editedOrder.filter((id) => revisedById.has(id)).map((id) => revisedById.get(id));
    const rest = next.nodes.filter((node) => !editedOrder.includes(node.id));
    next.nodes = [...ordered, ...rest];
  }

  next.locks = locks;
  return next;
}
