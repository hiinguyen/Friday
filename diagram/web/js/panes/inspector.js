import { h, clear, iconElement } from '../ui/dom.js';
import { uiIcon } from '../ui/icons.js';
import { ICONS, ICON_NAMES } from '../../../shared/icons/icons.js';
import { getTemplate } from '../../../shared/render/registry.js';
import { getTheme } from '../../../shared/render/themes.js';
import { LIMITS, COLOR_SLOTS } from '../../../shared/spec/constants.js';
import { setField, addNode, removeNode, moveNode } from '../../../shared/spec/ops.js';
import { currentSpec } from '../state.js';

const COMMIT_DELAY_MS = 300;
const INSTRUCTION_MAX = 500;
const LOCK_TITLE = 'Bạn đã sửa - AI sẽ giữ nguyên';
let fieldSeq = 0;

export function mount(el, { actions }) {
  const view = h('div', { class: 'inspector' });
  const instruction = h('textarea', { id: 'refine-instruction', rows: '3', maxlength: String(INSTRUCTION_MAX), placeholder: 'Ví dụ: rút gọn chữ, thêm bước kiểm thử' });
  const refineButton = h('button', { class: 'button primary block', type: 'button', onClick: () => actions.refine(instruction.value.trim()) }, uiIcon('sparkles', { size: 16 }), 'Hoàn thiện với AI');
  const refineBox = h('section', { class: 'refine-box' },
    h('h2', { class: 'pane-title', text: 'Hoàn thiện' }),
    h('p', { class: 'hint', text: 'AI chỉnh lại câu chữ và bố cục. Những chỗ bạn đã sửa được giữ nguyên.' }),
    h('label', { for: 'refine-instruction', text: 'Yêu cầu thêm (không bắt buộc)' }),
    instruction, refineButton);
  el.append(view);

  let key = null;
  let syncers = [];

  // One history entry per field focus: the first change after focus pushes, later ones in the
  // same focus replace the present.
  function bindCommit(input, makeEdit) {
    let session = false;
    let timer = null;
    const commit = () => {
      clearTimeout(timer);
      timer = null;
      const edit = makeEdit();
      if (!edit) return;
      actions.edit(edit, { coalesce: session });
      session = true;
    };
    input.addEventListener('focus', () => { session = false; });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(commit, COMMIT_DELAY_MS);
    });
    input.addEventListener('blur', () => { if (timer) commit(); });
  }

  function textField({ label, max, multiline = false, read, path, required = false, lockable = false }) {
    const id = `field-${(fieldSeq += 1)}`;
    const input = multiline
      ? h('textarea', { id, rows: '3', maxlength: String(max) })
      : h('input', { id, type: 'text', maxlength: String(max), autocomplete: 'off' });
    const counter = h('span', { class: 'counter', 'aria-hidden': 'true' });
    const syncCounter = () => { counter.textContent = `${input.value.length}/${max}`; };
    input.addEventListener('input', syncCounter);
    bindCommit(input, () => {
      if (required && input.value.trim() === '') return null;
      const value = input.value;
      return (spec) => setField(spec, path, value);
    });
    const lock = lockable ? h('span', { class: 'lock', role: 'img', title: LOCK_TITLE, 'aria-label': LOCK_TITLE, hidden: true }, uiIcon('lock', { size: 13 })) : null;
    syncers.push((spec) => {
      if (lock) lock.hidden = !(spec.locks ?? []).includes(path);
      if (document.activeElement === input) return;
      input.value = read(spec) ?? '';
      syncCounter();
    });
    return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', { for: id, text: label }), lock, counter), input);
  }

  function iconField(node) {
    const preview = h('span', { class: 'icon-preview' }, iconElement(ICONS[node.icon] ?? ICONS.circle, { size: 20 }));
    const search = h('input', { type: 'search', placeholder: 'Tìm biểu tượng...', 'aria-label': 'Tìm biểu tượng', autocomplete: 'off' });
    const grid = h('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Biểu tượng' });
    const popover = h('div', { class: 'icon-popover', hidden: true }, search, grid);
    const toggle = h('button', {
      class: 'button icon-toggle', type: 'button', 'aria-expanded': 'false',
      onClick: () => (popover.hidden ? open() : close()),
    }, preview, h('span', { text: node.icon }));
    const fill = () => {
      const query = search.value.trim().toLowerCase();
      grid.replaceChildren(...ICON_NAMES.filter((name) => name.includes(query)).map((name) => h('button', {
        class: 'icon-choice', type: 'button', title: name, 'aria-label': name, 'aria-pressed': String(name === node.icon),
        onClick: () => {
          close();
          actions.edit((spec) => setField(spec, `${node.id}.icon`, name));
        },
      }, iconElement(ICONS[name], { size: 20 }))));
    };
    function open() {
      popover.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      fill();
      search.focus();
    }
    function close() {
      popover.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
    search.addEventListener('input', fill);
    popover.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        toggle.focus();
      }
    });
    return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('span', { class: 'label', text: 'Biểu tượng' })), toggle, popover);
  }

  function colorField(node, theme) {
    const choices = [[null, 'Tự động', null], ...COLOR_SLOTS.map((slot, index) => [slot, `Màu ${index + 1}`, theme.accents[index]])];
    return h('div', { class: 'field' },
      h('div', { class: 'field-head' }, h('span', { class: 'label', text: 'Màu' })),
      h('div', { class: 'color-row', role: 'group', 'aria-label': 'Màu' }, choices.map(([slot, label, color]) => h('button', {
        class: `color-choice${slot === null ? ' auto' : ''}`, type: 'button', title: label, 'aria-label': label,
        'aria-pressed': String((node.color ?? null) === slot), style: color ? { background: color } : null,
        onClick: () => actions.edit((spec) => setField(spec, `${node.id}.color`, slot)),
      }))));
  }

  function nodeView(spec, node) {
    const template = getTemplate(spec.template);
    const theme = getTheme(spec.style?.theme);
    const index = spec.nodes.indexOf(node);
    const siblings = spec.nodes.filter((entry) => entry.parent === node.parent);
    const position = siblings.indexOf(node);
    const full = spec.nodes.length >= template.maxNodes;
    const add = (options) => {
      let created = null;
      actions.edit((current) => {
        const result = addNode(current, options);
        created = result.nodeId;
        return result.spec;
      });
      if (created) actions.select(created);
    };
    const emphasis = h('button', {
      class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(node.emphasis), id: 'field-emphasis',
      onClick: () => actions.edit((current) => setField(current, `${node.id}.emphasis`, !node.emphasis)),
    }, h('span', { class: 'switch-knob' }));
    const parts = [
      h('div', { class: 'inspector-head' },
        h('h2', { class: 'pane-title', text: `Mục ${index + 1}` }),
        h('button', { class: 'button ghost small', type: 'button', onClick: () => actions.select(null) }, 'Xong')),
      textField({ label: 'Nhãn', max: LIMITS.label, path: `${node.id}.label`, read: (s) => s.nodes.find((n) => n.id === node.id)?.label, required: true, lockable: true }),
      textField({ label: 'Mô tả', max: LIMITS.detail, multiline: true, path: `${node.id}.detail`, read: (s) => s.nodes.find((n) => n.id === node.id)?.detail }),
      iconField(node),
      colorField(node, theme),
      h('div', { class: 'field field-inline' }, h('label', { for: 'field-emphasis', text: 'Nhấn mạnh' }), emphasis),
    ];
    if (template.uses?.value) {
      const input = h('input', { id: 'field-value', type: 'number', step: 'any', inputmode: 'decimal' });
      bindCommit(input, () => {
        const raw = input.value.trim();
        const value = raw === '' ? null : Number(raw);
        if (value !== null && !Number.isFinite(value)) return null;
        return (current) => setField(current, `${node.id}.value`, value);
      });
      syncers.push((current) => {
        if (document.activeElement !== input) input.value = current.nodes.find((n) => n.id === node.id)?.value ?? '';
      });
      parts.push(h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', { for: 'field-value', text: 'Giá trị' })), input));
    }
    const fullTitle = full ? `Kiểu này có tối đa ${template.maxNodes} mục` : null;
    parts.push(h('div', { class: 'node-actions' },
      h('button', { class: 'button small', type: 'button', disabled: full, title: fullTitle, onClick: () => add({ after: node.id }) }, uiIcon('plus', { size: 15 }), 'Thêm mục cùng cấp'),
      template.uses?.parent ? h('button', { class: 'button small', type: 'button', disabled: full, title: fullTitle, onClick: () => add({ after: node.id, parent: node.id }) }, uiIcon('plus', { size: 15 }), 'Thêm mục con') : null,
      h('button', { class: 'button small', type: 'button', disabled: position <= 0, onClick: () => actions.edit((current) => moveNode(current, node.id, -1)) }, uiIcon('arrow-up', { size: 15 }), 'Lên'),
      h('button', { class: 'button small', type: 'button', disabled: position >= siblings.length - 1, onClick: () => actions.edit((current) => moveNode(current, node.id, 1)) }, uiIcon('arrow-down', { size: 15 }), 'Xuống'),
      h('button', {
        class: 'button small danger', type: 'button', disabled: spec.nodes.length <= template.minNodes,
        title: spec.nodes.length <= template.minNodes ? `Kiểu này cần ít nhất ${template.minNodes} mục` : null,
        onClick: () => {
          actions.select(null);
          actions.edit((current) => removeNode(current, node.id));
        },
      }, uiIcon('trash', { size: 15 }), 'Xoá')));
    return parts;
  }

  function diagramView(spec) {
    return [
      h('h2', { class: 'pane-title', text: 'Sơ đồ' }),
      textField({ label: 'Tiêu đề', max: LIMITS.title, path: 'title', read: (s) => s.title }),
      textField({ label: 'Phụ đề', max: LIMITS.subtitle, multiline: true, path: 'subtitle', read: (s) => s.subtitle }),
      h('div', { class: 'field' },
        h('div', { class: 'field-head' }, h('span', { class: 'label', text: 'Các mục' })),
        h('ul', { class: 'node-list' }, spec.nodes.map((node) => h('li', null, h('button', {
          class: 'node-row', type: 'button', onClick: () => actions.select(node.id),
        }, h('span', { class: 'node-row-icon' }, iconElement(ICONS[node.icon] ?? ICONS.circle, { size: 16 })), h('span', { class: 'node-row-label', text: node.label })))))),
      refineBox,
    ];
  }

  function update(state) {
    const spec = currentSpec(state);
    refineButton.disabled = Boolean(state.busy) || !spec;
    if (!spec) {
      key = null;
      syncers = [];
      view.replaceChildren(h('p', { class: 'hint', text: 'Chọn một phương án để chỉnh chi tiết ở đây.' }));
      return;
    }
    const node = state.selectedNodeId ? spec.nodes.find((entry) => entry.id === state.selectedNodeId) : null;
    const nextKey = JSON.stringify([state.sectionId, node?.id ?? null, spec.template, spec.style, spec.nodes.map((n) => [n.id, n.parent, n.icon, n.color, n.emphasis, node ? null : n.label])]);
    if (nextKey !== key) {
      key = nextKey;
      syncers = [];
      clear(view);
      view.append(...(node ? nodeView(spec, node) : diagramView(spec)).filter(Boolean));
    }
    for (const sync of syncers) sync(spec);
  }

  return { update };
}
