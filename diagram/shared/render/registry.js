import cards from './templates/cards.js';
import iconRow from './templates/icon-row.js';
import timeline from './templates/timeline.js';
import steps from './templates/steps.js';

export const TEMPLATES = [cards, iconRow, timeline, steps];
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
