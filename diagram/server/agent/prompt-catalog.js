import { TEMPLATES } from '../../shared/render/registry.js';
import { ICON_NAMES } from '../../shared/icons/icons.js';

export const USE_WHEN = {
  cards: 'independent points, features, reasons or tips',
  'icon-row': 'a few short parallel ideas that each fit an icon',
  timeline: 'dated events or phases in time order',
  steps: 'a linear process where each step leads to the next',
  flowchart: 'a process with branches, decisions or loops; fill edges',
  cycle: 'a repeating loop where the last step returns to the first',
  tree: 'an org chart, a taxonomy, or a whole broken into parts; fill parent',
  mindmap: 'one central topic with branches of related ideas; fill parent',
  compare: 'comparing 2-4 options; each option is a root node and its points are its children',
  funnel: 'stages that narrow down, usually with numbers; put the numbers in value',
  pyramid: 'levels of priority or foundation; the first node is the top',
  venn: '2-3 overlapping groups; each group is a root node and its points are its children',
};

export function catalogue() {
  return TEMPLATES
    .map((template) => `- ${template.id} (${template.kind}, ${template.minNodes}-${template.maxNodes} nodes): ${USE_WHEN[template.id]}`)
    .join('\n');
}

export function iconLine() {
  return `Icons: ${ICON_NAMES.join(', ')}`;
}
