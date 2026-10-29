import cards from './templates/cards.js';
import iconRow from './templates/icon-row.js';
import timeline from './templates/timeline.js';
import steps from './templates/steps.js';
import flowchart from './templates/flowchart.js';
import cycle from './templates/cycle.js';
import tree from './templates/tree.js';
import mindmap from './templates/mindmap.js';
import compare from './templates/compare.js';
import funnel from './templates/funnel.js';
import pyramid from './templates/pyramid.js';
import venn from './templates/venn.js';

export const TEMPLATES = [cards, iconRow, timeline, steps, flowchart, cycle, tree, mindmap, compare, funnel, pyramid, venn];
export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const TEMPLATE_KINDS = [...new Set(TEMPLATES.map((t) => t.kind))];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? cards;
}

export function compatibleTemplates(spec) {
  const count = spec.nodes.length;
  return TEMPLATES.map((template) => {
    let reason = null;
    if (count < template.minNodes || count > template.maxNodes) reason = `Cần ${template.minNodes}-${template.maxNodes} mục (đang có ${count})`;
    else reason = template.accepts(spec);
    return { id: template.id, label: template.label, kind: template.kind, ok: reason === null, reason };
  });
}
