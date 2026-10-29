import { h, clear } from '../ui/dom.js';

const STATUS = {
  none: 'Chưa có sơ đồ',
  candidates: 'Có phương án',
  chosen: 'Đã chọn sơ đồ',
};

function statusOf(project, sectionId) {
  const entry = project.diagrams?.[sectionId];
  if (entry?.chosen) return 'chosen';
  if (entry?.candidates?.length) return 'candidates';
  return 'none';
}

function blockContent(block, slideNumber) {
  if (block.kind === 'heading') return h('span', { class: `block-heading level-${block.level ?? 1}`, text: block.text });
  if (block.kind === 'list') {
    return h('ul', { class: 'block-list' }, block.text.split('\n').filter(Boolean).map((line) => h('li', { text: line.replace(/^\s*([-*•]|\d+[.)])\s+/, '') })));
  }
  if (block.kind === 'slide') {
    const [title, ...rest] = block.text.split('\n');
    return [h('span', { class: 'block-slide', text: `Trang chiếu ${slideNumber}` }), h('span', { class: 'block-heading', text: title }), rest.length ? h('span', { class: 'block-text', text: rest.join('\n') }) : null];
  }
  return h('span', { class: 'block-text', text: block.text });
}

export function mount(el, { actions }) {
  const banner = h('div', { class: 'question-banner', hidden: true },
    h('span', { text: 'AI đang chờ bạn trả lời' }),
    h('button', { class: 'button small', type: 'button', onClick: () => actions.openQuestions() }, 'Trả lời'));
  const sectionList = h('ul', { class: 'section-list', 'aria-label': 'Các phần' });
  const sectionEmpty = h('div', { class: 'section-empty', hidden: true });
  const blockList = h('ol', { class: 'block-list-doc' });
  const drawButton = h('button', { class: 'button primary draw-selection', type: 'button', hidden: true, onClick: () => drawSelection() }, 'Vẽ đoạn này');
  const closeButton = h('button', { class: 'button ghost small only-narrow drawer-close', type: 'button', onClick: () => actions.toggleDrawer(false) }, 'Đóng');
  el.append(
    h('div', { class: 'pane-head' }, h('h2', { class: 'pane-title', text: 'Các phần' }), closeButton),
    banner, sectionList, sectionEmpty,
    h('h2', { class: 'pane-title doc-title', text: 'Nội dung' }),
    h('p', { class: 'hint', text: 'Chọn các đoạn rồi bấm "Vẽ đoạn này" để vẽ riêng. Giữ Shift để chọn liền nhiều đoạn.' }),
    blockList, drawButton);

  const selected = new Set();
  let anchor = null;
  let blocks = [];
  let key = null;

  function drawSelection() {
    const ids = blocks.filter((block) => selected.has(block.id)).map((block) => block.id);
    if (ids.length === 0) return;
    selected.clear();
    anchor = null;
    key = null;
    actions.addSection(ids);
  }

  function toggleBlock(blockId, range) {
    if (range && anchor !== null) {
      const from = blocks.findIndex((block) => block.id === anchor);
      const to = blocks.findIndex((block) => block.id === blockId);
      const [start, end] = from < to ? [from, to] : [to, from];
      for (const block of blocks.slice(start, end + 1)) selected.add(block.id);
    } else if (selected.has(blockId)) {
      selected.delete(blockId);
    } else {
      selected.add(blockId);
    }
    anchor = blockId;
    for (const item of blockList.children) item.firstChild.setAttribute('aria-pressed', String(selected.has(item.dataset.block)));
    drawButton.hidden = selected.size === 0;
    drawButton.textContent = selected.size > 1 ? `Vẽ ${selected.size} đoạn này` : 'Vẽ đoạn này';
  }

  function update(state) {
    const { project, sectionId, busy } = state;
    banner.hidden = !project.pendingQuestions || Boolean(busy) || Boolean(state.asking);
    const nextKey = JSON.stringify([project.updatedAt, sectionId, Boolean(busy), project.sections, Object.keys(project.diagrams ?? {}).map((id) => [id, statusOf(project, id)])]);
    if (nextKey === key) return;
    key = nextKey;
    blocks = project.document.blocks;

    clear(sectionList);
    for (const section of project.sections) {
      const status = statusOf(project, section.id);
      const current = section.id === sectionId;
      sectionList.append(h('li', null, h('button', {
        class: 'section-row', type: 'button', 'aria-current': current ? 'true' : null,
        onClick: () => actions.openSection(section.id),
      },
      h('span', { class: `status-dot ${status}`, 'aria-hidden': 'true' }),
      h('span', { class: 'section-name', text: section.title }),
      h('span', { class: 'visually-hidden', text: `, ${STATUS[status]}` }),
      h('span', { class: 'meta', text: `${section.blockIds.length} đoạn` }))));
    }
    clear(sectionEmpty);
    sectionEmpty.hidden = project.sections.length > 0;
    if (project.sections.length === 0) {
      sectionEmpty.append(
        h('p', { class: 'hint', text: 'AI chưa chia phần.' }),
        h('button', { class: 'button small', type: 'button', disabled: Boolean(busy), onClick: () => actions.segment() }, 'Phân tích lại'));
    }

    const open = new Set(project.sections.find((section) => section.id === sectionId)?.blockIds ?? []);
    clear(blockList);
    let slide = 0;
    for (const block of blocks) {
      if (block.kind === 'slide') slide += 1;
      blockList.append(h('li', { class: open.has(block.id) ? 'in-section' : null, 'data-block': block.id }, h('button', {
        class: `doc-block doc-block-${block.kind}`, type: 'button', 'aria-pressed': String(selected.has(block.id)),
        onClick: (event) => toggleBlock(block.id, event.shiftKey),
      }, blockContent(block, slide))));
    }
    drawButton.hidden = selected.size === 0;
    drawButton.disabled = Boolean(busy);
  }

  return { update };
}
