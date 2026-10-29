import { makeNodes } from './specs.js';

const SHORT = ['Nghiên cứu', 'Thiết kế', 'Phát triển', 'Kiểm thử', 'Ra mắt', 'Đo lường', 'Cải tiến', 'Mở rộng', 'Bảo trì', 'Đào tạo', 'Hỗ trợ', 'Tối ưu', 'Báo cáo', 'Đánh giá', 'Lưu trữ', 'Chia sẻ'];
const LONG_LABEL = 'Phỏng vấn sâu ba mươi khách hàng doanh nghiệp vừa và nhỏ';
const LONG_DETAIL = 'Ghi lại nhu cầu, rào cản và mức sẵn sàng chi trả của từng nhóm khách hàng để ưu tiên tính năng cho bản phát hành đầu tiên của sản phẩm mới.';
const FUNNEL_VALUES = [1000, 640, 410, 260, 170, 110];

function labelFor(index, long) {
  if (!long) return SHORT[index % SHORT.length];
  return `${LONG_LABEL} ${index + 1}`.slice(0, 60);
}

function assignHierarchy(nodes) {
  for (let i = 1; i < nodes.length; i += 1) {
    const parentIndex = Math.min(Math.floor((i - 1) / 4), i - 1);
    nodes[i].parent = nodes[parentIndex].id;
  }
}

function assignCompare(nodes) {
  const roots = Math.min(4, Math.max(2, Math.floor(nodes.length / 3)));
  for (let i = roots; i < nodes.length; i += 1) nodes[i].parent = nodes[(i - roots) % roots].id;
}

function assignVenn(nodes) {
  const roots = nodes.length <= 5 ? 2 : 3;
  for (let i = roots; i < nodes.length; i += 1) nodes[i].parent = nodes[(i - roots) % roots].id;
}

export function sampleSpec(template, count, { long = false, theme = 'classic' } = {}) {
  const nodes = makeNodes(count);
  nodes.forEach((node, index) => {
    node.label = labelFor(index, long);
    node.detail = long ? LONG_DETAIL : '';
    node.emphasis = long && index % 3 === 0;
  });
  const edges = [];
  if (template.uses && template.uses.edges) {
    for (let i = 0; i < count - 1; i += 1) edges.push({ from: `n${i + 1}`, to: `n${i + 2}`, label: '' });
    if (count >= 4) edges.push({ from: 'n1', to: 'n3', label: '' });
  } else if (template.id === 'venn') {
    assignVenn(nodes);
  } else if (template.id === 'compare') {
    assignCompare(nodes);
  } else if (template.uses && template.uses.parent) {
    assignHierarchy(nodes);
  }
  if (template.id === 'funnel') {
    nodes.forEach((node, index) => {
      if (index < FUNNEL_VALUES.length) node.value = FUNNEL_VALUES[index];
    });
  }
  return {
    version: 1,
    id: 'd_sample',
    sectionId: 's1',
    template: template.id,
    title: long ? 'Lộ trình ra mắt sản phẩm trong bốn quý tới cho thị trường' : 'Lộ trình ra mắt',
    subtitle: '',
    lang: 'vi',
    nodes,
    edges,
    style: { theme, density: 'normal' },
    locks: [],
  };
}
