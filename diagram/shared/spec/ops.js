import { LIMITS } from './constants.js';

const NODE_FIELDS = ['label', 'detail', 'icon', 'color', 'emphasis', 'value'];
const TEXT_FIELDS = ['label', 'detail'];
const UNLOCKED_FIELDS = ['emphasis', 'value'];

function clip(text, max) {
  const value = String(text ?? '').normalize('NFC').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function addLock(locks, path) {
  const list = Array.isArray(locks) ? locks : [];
  return list.includes(path) ? [...list] : [...list, path];
}

function withoutLocksFor(locks, nodeId) {
  return (Array.isArray(locks) ? locks : []).filter((lock) => !lock.startsWith(`${nodeId}.`));
}

function nextNodeId(nodes) {
  const used = new Set(nodes.map((node) => node.id));
  let index = 1;
  while (used.has(`n${index}`)) index += 1;
  return `n${index}`;
}

export function setField(spec, path, value) {
  const next = structuredClone(spec);
  const [head, field] = path.split('.');
  if (field === undefined) {
    if (head !== 'title' && head !== 'subtitle') throw new Error(`unknown field path "${path}"`);
    next[head] = typeof value === 'string' ? clip(value, LIMITS[head]) : value;
    next.locks = addLock(next.locks, path);
    return next;
  }
  const node = next.nodes.find((entry) => entry.id === head);
  if (!node) throw new Error(`unknown node "${head}"`);
  if (!NODE_FIELDS.includes(field)) throw new Error(`unknown node field "${field}"`);
  node[field] = TEXT_FIELDS.includes(field) ? clip(value, LIMITS[field]) : value;
  if (!UNLOCKED_FIELDS.includes(field)) next.locks = addLock(next.locks, path);
  return next;
}

export function addNode(spec, { after = null, parent, label = 'Mục mới' } = {}) {
  const next = structuredClone(spec);
  const nodeId = nextNodeId(next.nodes);
  const anchor = after === null ? null : next.nodes.find((node) => node.id === after);
  if (after !== null && !anchor) throw new Error(`unknown node "${after}"`);
  const parentId = parent !== undefined ? parent : anchor && anchor.parent !== null ? anchor.parent : null;
  const node = { id: nodeId, label, detail: '', icon: 'circle', parent: parentId, value: null, emphasis: false, color: null };
  if (anchor) next.nodes.splice(next.nodes.indexOf(anchor) + 1, 0, node);
  else next.nodes.push(node);
  next.locks = addLock(addLock(next.locks, 'nodes.order'), `${nodeId}.label`);
  return { spec: next, nodeId };
}

export function removeNode(spec, nodeId) {
  const next = structuredClone(spec);
  const target = next.nodes.find((node) => node.id === nodeId);
  if (!target) throw new Error(`unknown node "${nodeId}"`);
  next.nodes = next.nodes.filter((node) => node.id !== nodeId);
  for (const node of next.nodes) {
    if (node.parent === nodeId) node.parent = target.parent;
  }
  next.edges = next.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  next.locks = addLock(withoutLocksFor(next.locks, nodeId), 'nodes.order');
  return next;
}

export function moveNode(spec, nodeId, delta) {
  const next = structuredClone(spec);
  const index = next.nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) throw new Error(`unknown node "${nodeId}"`);
  const node = next.nodes[index];
  const siblings = next.nodes.filter((entry) => entry.parent === node.parent);
  const position = siblings.findIndex((entry) => entry.id === nodeId);
  const other = siblings[position + delta];
  if (!other) return next;
  const otherIndex = next.nodes.indexOf(other);
  next.nodes[index] = other;
  next.nodes[otherIndex] = node;
  next.locks = addLock(next.locks, 'nodes.order');
  return next;
}

export function setTemplate(spec, templateId) {
  const next = structuredClone(spec);
  next.template = templateId;
  return next;
}

export function setStyle(spec, patch) {
  const next = structuredClone(spec);
  next.style = { ...next.style, ...patch };
  return next;
}
