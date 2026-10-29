import { h, clear, svgFromMarkup } from '../ui/dom.js';
import { uiIcon } from '../ui/icons.js';
import { layoutSpec, paintScene, renderSpec } from '../../../shared/render/render.js';
import { getTemplate } from '../../../shared/render/registry.js';
import { getTheme } from '../../../shared/render/themes.js';
import { MARGIN, TYPE } from '../../../shared/render/kit.js';
import { LIMITS } from '../../../shared/spec/constants.js';
import { setField } from '../../../shared/spec/ops.js';
import { canUndo, canRedo } from '../../../shared/spec/history.js';
import { currentSpec } from '../state.js';

const FIELD_NAMES = { label: 'Nhãn', detail: 'Mô tả', title: 'Tiêu đề', subtitle: 'Phụ đề' };
const FIELD_STYLE = { label: 'label', detail: 'detail', title: 'title', subtitle: 'subtitle' };
const MIN_EDITOR_FONT = 14;
const MIN_EDITOR_WIDTH = 160;
const px = (value) => `${Math.round(value * 100) / 100}px`;

// Everything that changes the layout; a theme change only repaints the cached scene.
function layoutKey(spec) {
  return JSON.stringify({ ...spec, style: { ...spec.style, theme: null }, locks: null });
}

export function thumbnail(spec, fontSet) {
  try {
    const svg = svgFromMarkup(renderSpec(spec, { fontSet }).svg);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    return svg;
  } catch {
    return h('span', { class: 'thumb-missing', text: 'Không xem trước được' });
  }
}

export function mount(el, { actions, fontSet }) {
  const undoButton = h('button', { class: 'button icon', type: 'button', 'aria-label': 'Hoàn tác', title: 'Hoàn tác (Ctrl+Z)', onClick: () => actions.undo() }, uiIcon('undo'));
  const redoButton = h('button', { class: 'button icon', type: 'button', 'aria-label': 'Làm lại', title: 'Làm lại (Ctrl+Shift+Z)', onClick: () => actions.redo() }, uiIcon('redo'));
  const againButton = h('button', { class: 'button small', type: 'button', title: 'AI vẽ ba phương án mới', onClick: () => actions.generate(lastState.sectionId) }, 'Vẽ lại');
  const candidateStrip = h('div', { class: 'candidates', role: 'group', 'aria-label': 'Các phương án' });
  const tools = h('div', { class: 'canvas-tools' }, againButton, undoButton, redoButton);
  const header = h('div', { class: 'canvas-head' }, candidateStrip, tools);
  const message = h('div', { class: 'canvas-message' });
  const outline = h('div', { class: 'selection-outline', hidden: true });
  const surface = h('div', { class: 'stage-surface' }, outline);
  const stage = h('div', { class: 'stage', tabindex: '0', 'data-editor-scope': '', 'aria-label': 'Sơ đồ. Bấm vào một mục để chọn, bấm đúp để sửa chữ.' }, surface);
  el.append(header, message, stage);

  let shown = { spec: null, key: null, scene: null, svg: null };
  let candidatesKey = null;
  let editor = null;
  let lastState = null;
  let lastSelected = null;

  const scale = () => (shown.svg ? shown.svg.getBoundingClientRect().width / shown.scene.width : 1);

  function setMessage(text, button = null) {
    clear(message);
    message.append(h('p', { text }));
    if (button) message.append(button);
  }

  function updateCandidates(candidates, picked, sectionId) {
    const key = `${sectionId}|${picked}|${JSON.stringify(candidates)}`;
    if (key === candidatesKey) return;
    candidatesKey = key;
    clear(candidateStrip);
    candidates.forEach((candidate, index) => {
      const label = getTemplate(candidate.template).label;
      candidateStrip.append(h('button', {
        class: 'candidate', type: 'button', 'aria-pressed': String(picked === index),
        'aria-label': `Phương án ${index + 1}: ${label}`, onClick: () => actions.chooseCandidate(index),
      }, h('span', { class: 'candidate-thumb' }, thumbnail(candidate, fontSet)), h('span', { class: 'candidate-label', text: `${index + 1}. ${label}` })));
    });
    candidateStrip.hidden = candidates.length === 0;
  }

  function renderMain(spec) {
    if (shown.spec === spec) return;
    closeEditor(false);
    const key = layoutKey(spec);
    const scene = key === shown.key ? shown.scene : layoutSpec(spec, fontSet);
    const svg = svgFromMarkup(paintScene(scene, spec, fontSet));
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('diagram');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', spec.title || 'Sơ đồ');
    if (shown.svg) shown.svg.replaceWith(svg);
    else surface.prepend(svg);
    stage.style.background = getTheme(spec.style?.theme).background;
    shown = { spec, key, scene, svg };
  }

  function placeOutline(nodeId) {
    const box = nodeId && shown.scene ? shown.scene.nodes[nodeId] : null;
    if (!box) {
      outline.hidden = true;
      return;
    }
    const s = scale();
    Object.assign(outline.style, { left: px(box.x * s), top: px(box.y * s), width: px(box.w * s), height: px(box.h * s) });
    outline.hidden = false;
    if (nodeId !== lastSelected) outline.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // The box of a text in scene units. Empty text has no item: a detail goes under its label,
  // a subtitle under the title, anything else on the node box or the title area.
  function textTarget(nodeId, field) {
    const role = nodeId ? `node-${field}` : field;
    const item = shown.scene.items.find((entry) => entry.type === 'text' && entry.role === role && (!nodeId || entry.nodeId === nodeId));
    if (item) return { box: item.box, item };
    if (nodeId && field === 'detail') {
      const label = textTarget(nodeId, 'label');
      if (label?.item) return { box: { ...label.box, y: label.box.y + label.box.h + 4, h: 24 }, item: null };
    }
    if (nodeId) return shown.scene.nodes[nodeId] ? { box: shown.scene.nodes[nodeId], item: null } : null;
    if (field === 'subtitle') {
      const title = textTarget(null, 'title');
      if (title?.item) return { box: { ...title.box, y: title.box.y + title.box.h + 8, h: 24 }, item: null };
    }
    return { box: { x: MARGIN, y: MARGIN, w: shown.scene.width - 2 * MARGIN, h: 36 }, item: null };
  }

  function closeEditor(commit) {
    if (!editor) return;
    const { textarea, nodeId, field, original } = editor;
    editor = null;
    textarea.remove();
    if (!commit) return;
    const value = textarea.value.replace(/\s+/g, ' ').trim();
    if (value === original.trim() || (field === 'label' && value === '')) return;
    actions.edit((spec) => setField(spec, nodeId ? `${nodeId}.${field}` : field, value));
  }

  function startEdit({ nodeId = null, field = 'label' } = {}) {
    const spec = shown.spec;
    if (!spec) return false;
    const node = nodeId ? spec.nodes.find((entry) => entry.id === nodeId) : null;
    if (nodeId && !node) return false;
    const target = textTarget(nodeId, field);
    if (!target) return false;
    closeEditor(true);
    const s = scale();
    const { box, item } = target;
    const type = TYPE[FIELD_STYLE[field]];
    const anchor = item?.anchor ?? (nodeId ? 'start' : 'middle');
    const width = Math.max(box.w * s, MIN_EDITOR_WIDTH);
    const left = anchor === 'middle' ? (box.x + box.w / 2) * s - width / 2 : box.x * s;
    const textarea = h('textarea', { class: 'inline-editor', rows: '1', maxlength: String(LIMITS[field]), 'aria-label': FIELD_NAMES[field], spellcheck: 'false' });
    textarea.value = (node ? node[field] : spec[field]) ?? '';
    Object.assign(textarea.style, {
      left: px(Math.max(0, left - 6)), top: px(Math.max(0, box.y * s - 4)), width: px(width + 12),
      fontSize: px(Math.max((item?.size ?? type.size) * s, MIN_EDITOR_FONT)), fontWeight: String(item?.weight ?? type.weight),
      textAlign: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
    });
    const grow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = px(textarea.scrollHeight);
    };
    textarea.addEventListener('input', grow);
    textarea.addEventListener('blur', () => closeEditor(true));
    textarea.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeEditor(false);
        stage.focus({ preventScroll: true });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        closeEditor(true);
        if (event.shiftKey && nodeId && field === 'label') startEdit({ nodeId, field: 'detail' });
        else stage.focus({ preventScroll: true });
      }
    });
    surface.append(textarea);
    editor = { textarea, nodeId, field, original: textarea.value };
    grow();
    textarea.focus({ preventScroll: true });
    textarea.select();
    return true;
  }

  surface.addEventListener('click', (event) => {
    if (event.target === editor?.textarea) return;
    const hit = event.target.closest('[data-node-id]');
    actions.select(hit ? hit.getAttribute('data-node-id') : null);
    stage.focus({ preventScroll: true });
  });
  surface.addEventListener('dblclick', (event) => {
    if (event.target === editor?.textarea) return;
    const hit = event.target.closest('[data-node-id]');
    if (hit) {
      startEdit({ nodeId: hit.getAttribute('data-node-id'), field: hit.getAttribute('data-role') === 'node-detail' ? 'detail' : 'label' });
      return;
    }
    const role = event.target.closest('[data-role]')?.getAttribute('data-role');
    if (role === 'title' || role === 'subtitle') startEdit({ field: role });
  });
  new ResizeObserver(() => {
    if (lastState) placeOutline(lastState.selectedNodeId);
    if (editor) closeEditor(true);
  }).observe(surface);

  function update(state) {
    lastState = state;
    const section = state.project.sections.find((entry) => entry.id === state.sectionId) ?? null;
    const candidates = section ? state.project.diagrams?.[section.id]?.candidates ?? [] : [];
    const history = section ? state.histories[section.id] : null;
    const spec = currentSpec(state);
    const generating = state.busy?.task === 'generate' && state.busy.sectionId === state.sectionId;

    header.hidden = !section;
    updateCandidates(candidates, state.picked?.[state.sectionId] ?? null, state.sectionId);
    againButton.hidden = candidates.length === 0;
    againButton.disabled = Boolean(state.busy);
    undoButton.hidden = !spec;
    redoButton.hidden = !spec;
    undoButton.disabled = !history || !canUndo(history);
    redoButton.disabled = !history || !canRedo(history);

    if (!section) {
      setMessage('Chọn một phần để vẽ sơ đồ.', h('button', { class: 'button only-narrow', type: 'button', onClick: () => actions.toggleDrawer(true) }, 'Mở nội dung'));
    } else if (!spec && generating) {
      setMessage('AI đang vẽ phương án...');
    } else if (!spec && candidates.length > 0) {
      setMessage('Chọn một phương án ở trên để bắt đầu chỉnh.');
    } else if (!spec) {
      setMessage('Phần này chưa có phương án.', h('button', { class: 'button primary', type: 'button', disabled: Boolean(state.busy), onClick: () => actions.generate(state.sectionId) }, 'Vẽ phương án'));
    }
    message.hidden = Boolean(spec);
    stage.hidden = !spec;
    if (spec) renderMain(spec);
    placeOutline(state.selectedNodeId);
    lastSelected = state.selectedNodeId;
  }

  return { update, startEdit };
}
