export function makeNodes(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index + 1}`,
    label: `Bước ${index + 1}`,
    detail: '',
    icon: 'circle',
    parent: null,
    value: null,
    emphasis: false,
    color: null,
    ...overrides,
  }));
}

export function makeSpec(overrides = {}) {
  return {
    version: 1,
    id: 'd_test',
    sectionId: 's1',
    template: 'cards',
    title: 'Tiêu đề',
    subtitle: '',
    lang: 'vi',
    nodes: makeNodes(3),
    edges: [],
    style: { theme: 'classic', density: 'normal' },
    locks: [],
    ...overrides,
  };
}

export const LIST_TEMPLATE = { id: 'cards', minNodes: 2, maxNodes: 9, uses: { parent: false, edges: false, value: false } };
export const TREE_TEMPLATE = { id: 'tree', minNodes: 3, maxNodes: 15, uses: { parent: true, edges: false, value: false } };
export const FLOW_TEMPLATE = { id: 'flowchart', minNodes: 3, maxNodes: 12, uses: { parent: false, edges: true, value: false } };
