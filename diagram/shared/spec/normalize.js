import { COLOR_SLOTS, DEFAULT_THEME, DENSITY_NAMES, FALLBACK_ICON, LIMITS, SPEC_VERSION } from './constants.js';
import { findCycleNode } from './tree.js';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function clip(text, max) {
  const value = String(text ?? '').normalize('NFC').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clipReported(text, max, field, repairs) {
  const value = String(text ?? '').normalize('NFC').trim();
  if (value.length > max) repairs.push(`${field} was longer than ${max} characters and was clipped`);
  return clip(value, max);
}

function randomId() {
  let out = '';
  while (out.length < 4) out += Math.random().toString(36).slice(2);
  return out.slice(0, 4);
}

export function normalizeSpec(raw, { template, iconNames = [], sectionId } = {}) {
  const repairs = [];
  const source = isObject(raw) ? raw : {};
  const spec = structuredClone(source);

  spec.version = SPEC_VERSION;
  if (typeof spec.id !== 'string' || spec.id.trim() === '') spec.id = `d_${randomId()}`;
  if (sectionId !== undefined) spec.sectionId = sectionId;
  spec.template = template.id;
  spec.title = clipReported(spec.title, LIMITS.title, 'title', repairs);
  spec.subtitle = clipReported(spec.subtitle, LIMITS.subtitle, 'subtitle', repairs);
  if (typeof spec.lang !== 'string' || spec.lang.trim() === '') spec.lang = 'vi';

  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes.filter(isObject) : [];
  const used = new Set();
  let counter = 0;
  const kept = [];
  for (const rawNode of rawNodes) {
    let id = typeof rawNode.id === 'string' ? rawNode.id.trim() : '';
    if (id === '' || used.has(id)) {
      let candidate;
      do {
        counter += 1;
        candidate = `n${counter}`;
      } while (used.has(candidate));
      repairs.push(`renamed a node with a missing or duplicate id to ${candidate}`);
      id = candidate;
    }
    const label = clipReported(rawNode.label, LIMITS.label, `label of ${id}`, repairs);
    if (label === '') {
      repairs.push('dropped a node with an empty label');
      continue;
    }
    used.add(id);
    kept.push({ raw: rawNode, id, label });
  }

  const ids = new Set(kept.map((entry) => entry.id));
  let nodes = kept.map(({ raw: rawNode, id, label }) => {
    const detail = clipReported(rawNode.detail, LIMITS.detail, `detail of ${id}`, repairs);
    let icon = typeof rawNode.icon === 'string' ? rawNode.icon : '';
    if (!iconNames.includes(icon)) {
      if (rawNode.icon !== undefined) repairs.push(`replaced an unknown icon on ${id}`);
      icon = FALLBACK_ICON;
    }
    let parent = null;
    if (typeof rawNode.parent === 'string' && rawNode.parent !== id && ids.has(rawNode.parent)) parent = rawNode.parent;
    else if (rawNode.parent != null) repairs.push(`cleared a dangling parent on ${id}`);
    let color = null;
    if (COLOR_SLOTS.includes(rawNode.color)) color = rawNode.color;
    else if (rawNode.color != null) repairs.push(`cleared an invalid colour on ${id}`);
    const value = typeof rawNode.value === 'number' && Number.isFinite(rawNode.value) ? rawNode.value : null;
    return { ...rawNode, id, label, detail, icon, parent, value, emphasis: rawNode.emphasis === true, color };
  });

  let cycleGuard = 0;
  let cycleNode = findCycleNode(nodes);
  while (cycleNode !== null && cycleGuard <= nodes.length + 1) {
    const node = nodes.find((entry) => entry.id === cycleNode);
    if (node) node.parent = null;
    repairs.push('broke a parent cycle');
    cycleNode = findCycleNode(nodes);
    cycleGuard += 1;
  }

  if (!template.uses.parent) {
    if (nodes.some((node) => node.parent !== null)) repairs.push('cleared parents the template does not use');
    for (const node of nodes) node.parent = null;
  }

  if (template.uses.edges) {
    const seenEdges = new Set();
    const edges = [];
    for (const rawEdge of Array.isArray(spec.edges) ? spec.edges : []) {
      if (!isObject(rawEdge)) continue;
      const { from, to } = rawEdge;
      if (!ids.has(from) || !ids.has(to) || from === to) continue;
      const key = `${from}\u0000${to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ from, to, label: String(rawEdge.label ?? '') });
    }
    spec.edges = edges;
  } else {
    spec.edges = [];
  }

  if (nodes.length > template.maxNodes) {
    nodes = nodes.slice(0, template.maxNodes);
    const keptIds = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
      if (node.parent !== null && !keptIds.has(node.parent)) node.parent = null;
    }
    if (template.uses.edges) spec.edges = spec.edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
    repairs.push(`truncated to ${template.maxNodes} nodes`);
  }

  const style = isObject(spec.style) ? spec.style : {};
  spec.style = {
    theme: typeof style.theme === 'string' && style.theme.trim() !== '' ? style.theme : DEFAULT_THEME,
    density: DENSITY_NAMES.includes(style.density) ? style.density : 'normal',
  };

  spec.locks = Array.isArray(spec.locks)
    ? [...new Set(spec.locks.filter((lock) => typeof lock === 'string'))]
    : [];

  if (nodes.length < template.minNodes) repairs.push(`too few nodes for ${template.id}`);

  // validate requires a non-empty title, so a missing one falls back to the first node label.
  if (spec.title === '') {
    spec.title = clip(nodes.length > 0 ? nodes[0].label : '', LIMITS.title) || 'Sơ đồ';
    repairs.push('filled an empty title');
  }

  spec.nodes = nodes;
  return { spec, repairs };
}
