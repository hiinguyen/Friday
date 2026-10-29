import { h } from '../ui/dom.js';
import { uiIcon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { showBusy, hideBusy } from '../ui/progress.js';
import { createHistory, pushHistory, replaceHistory, undo, redo, canUndo, canRedo } from '../../../shared/spec/history.js';
import { removeNode } from '../../../shared/spec/ops.js';
import { getTemplate } from '../../../shared/render/registry.js';
import { selectSection, currentSpec } from '../state.js';
import { createSaver } from '../editor/save.js';
import { installKeys } from '../editor/keys.js';
import { openQuestions } from '../dialogs/questions.js';
import { openExport } from '../dialogs/export.js';
import * as sourcePane from '../panes/source.js';
import * as canvasPane from '../panes/canvas.js';
import * as pickersPane from '../panes/pickers.js';
import * as inspectorPane from '../panes/inspector.js';

const BUSY_LABELS = {
  segment: 'AI đang phân tích nội dung...',
  generate: 'AI đang vẽ phương án...',
  refine: 'AI đang hoàn thiện sơ đồ...',
};
const NARROW = '(max-width: 899px)';

function withChosen(project, sectionId, spec) {
  const entry = project.diagrams?.[sectionId] ?? { candidates: [], chosen: null };
  return { ...project, diagrams: { ...project.diagrams, [sectionId]: { ...entry, chosen: spec } } };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountProject(el, { store, api, fontSet, go, topbarSlot }) {
  let alive = true;
  let questionsOpen = false;
  let drawerOpen = false;
  const projectId = () => store.get().project.id;

  const sourceEl = h('aside', { class: 'pane pane-source', id: 'source-pane', 'aria-label': 'Nội dung' });
  const canvasEl = h('div', { class: 'canvas' });
  const pickersEl = h('div', { class: 'pickers' });
  const mainEl = h('section', { class: 'pane pane-main', 'aria-label': 'Sơ đồ' }, canvasEl, pickersEl);
  const inspectorEl = h('aside', { class: 'pane pane-inspector', 'aria-label': 'Thuộc tính' });
  const scrim = h('div', { class: 'scrim', hidden: true });
  const root = h('div', { class: 'project' }, sourceEl, mainEl, inspectorEl, scrim);
  el.append(root);

  const drawerButton = h('button', { class: 'button only-narrow', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'source-pane' }, uiIcon('panel', { size: 16 }), 'Nội dung');
  const docName = h('span', { class: 'doc-name' });
  const exportButton = h('button', { class: 'button primary', type: 'button' }, uiIcon('download', { size: 16 }), 'Xuất');
  topbarSlot.append(drawerButton, docName, exportButton);

  const saver = createSaver({
    save: async (sectionId, spec) => {
      await api.saveDiagram(projectId(), sectionId, spec);
      if (alive) store.set({ project: withChosen(store.get().project, sectionId, spec) });
    },
    onError: (error) => toast(error.message, { kind: 'error' }),
  });

  // Every agent call: busy bar with "Huỷ", the project from the answer, a quiet toast when
  // cancelled and an error toast with "Thử lại" otherwise.
  async function agentCall(task, { sectionId = null, run, retry }) {
    if (store.get().busy) return null;
    const id = projectId();
    store.set({ busy: { task, sectionId, label: BUSY_LABELS[task] } });
    showBusy({ label: BUSY_LABELS[task], onCancel: () => api.cancel(id).catch(() => {}) });
    try {
      const project = await run(id);
      if (alive) store.set({ project });
      return alive ? project : null;
    } catch (error) {
      if (!alive) return null;
      if (error.code === 'cancelled') toast('Đã huỷ.', { kind: 'info' });
      else toast(error.message, { kind: 'error', action: retry ? { label: 'Thử lại', onClick: retry } : null });
      return null;
    } finally {
      hideBusy();
      if (alive) {
        store.set({ busy: null });
        askQuestions();
      }
    }
  }

  function askQuestions() {
    const pending = store.get().project.pendingQuestions;
    if (!pending || questionsOpen || store.get().busy) return;
    questionsOpen = true;
    store.set({ asking: true });
    const done = () => {
      questionsOpen = false;
      if (alive) store.set({ asking: false });
    };
    openQuestions({
      questions: pending.questions,
      onSkip: done,
      onSubmit: (answers) => {
        done();
        if (pending.task === 'segment') actions.segment(answers);
        else actions.openSection(pending.sectionId, answers);
      },
    });
  }

  function stepHistory(move, can) {
    const state = store.get();
    const history = state.histories[state.sectionId];
    if (!history || !can(history)) return false;
    const next = move(history);
    const selectedNodeId = next.present.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : null;
    store.set({ histories: { ...state.histories, [state.sectionId]: next }, selectedNodeId });
    saver.schedule(state.sectionId, next.present);
    return true;
  }

  const actions = {
    segment: (answers = []) => agentCall('segment', { run: (id) => api.segment(id, answers), retry: () => actions.segment(answers) }),

    async generate(sectionId, answers = []) {
      const project = await agentCall('generate', { sectionId, run: (id) => api.generate(id, sectionId, answers), retry: () => actions.generate(sectionId, answers) });
      if (project) store.set({ picked: { ...store.get().picked, [sectionId]: null } });
    },

    openSection(sectionId, answers = null) {
      actions.toggleDrawer(false);
      go(`#/p/${encodeURIComponent(projectId())}/s/${encodeURIComponent(sectionId)}`);
      const entry = store.get().project.diagrams?.[sectionId];
      if (answers || (!entry?.chosen && !entry?.candidates?.length)) actions.generate(sectionId, answers ?? []);
    },

    async addSection(blockIds) {
      try {
        const project = await api.addSection(projectId(), blockIds);
        store.set({ project });
        actions.openSection(project.sections.at(-1).id);
      } catch (error) {
        toast(error.message, { kind: 'error' });
      }
    },

    chooseCandidate(index) {
      const state = store.get();
      const sectionId = state.sectionId;
      const candidate = state.project.diagrams?.[sectionId]?.candidates?.[index];
      if (!candidate) return;
      const spec = { ...structuredClone(candidate), sectionId };
      store.set({ histories: { ...state.histories, [sectionId]: createHistory(spec) }, picked: { ...state.picked, [sectionId]: index }, selectedNodeId: null });
      saver.schedule(sectionId, spec);
      saver.flush();
    },

    edit(change, { coalesce = false } = {}) {
      const state = store.get();
      const history = state.histories[state.sectionId];
      if (!history) return false;
      const next = change(history.present);
      if (!next || next === history.present) return false;
      const updated = coalesce ? replaceHistory(history, next) : pushHistory(history, next);
      if (updated === history) return false;
      const selectedNodeId = next.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : null;
      store.set({ histories: { ...state.histories, [state.sectionId]: updated }, selectedNodeId });
      saver.schedule(state.sectionId, next);
      return true;
    },

    undo: () => stepHistory(undo, canUndo),
    redo: () => stepHistory(redo, canRedo),

    select(nodeId) {
      if (store.get().selectedNodeId === nodeId) return false;
      store.set({ selectedNodeId: nodeId });
      return true;
    },

    selectStep(delta) {
      const state = store.get();
      const spec = currentSpec(state);
      if (!spec || spec.nodes.length === 0) return false;
      const index = spec.nodes.findIndex((node) => node.id === state.selectedNodeId);
      const next = index === -1 ? (delta > 0 ? 0 : spec.nodes.length - 1) : Math.min(spec.nodes.length - 1, Math.max(0, index + delta));
      actions.select(spec.nodes[next].id);
      return true;
    },

    removeSelected() {
      const state = store.get();
      const spec = currentSpec(state);
      if (!spec || !state.selectedNodeId) return false;
      const { minNodes } = getTemplate(spec.template);
      if (spec.nodes.length <= minNodes) {
        toast(`Kiểu này cần ít nhất ${minNodes} mục.`, { kind: 'info' });
        return true;
      }
      const nodeId = state.selectedNodeId;
      actions.select(null);
      return actions.edit((current) => removeNode(current, nodeId));
    },

    editSelected() {
      const nodeId = store.get().selectedNodeId;
      return nodeId ? canvas.startEdit({ nodeId, field: 'label' }) : false;
    },

    // The refined spec goes on top of the history, so one undo returns to the version sent.
    async refine(instruction) {
      const state = store.get();
      const sectionId = state.sectionId;
      const spec = currentSpec(state);
      if (!spec) return;
      await saver.flush();
      const project = await agentCall('refine', { sectionId, run: (id) => api.refine(id, sectionId, spec, instruction), retry: () => actions.refine(instruction) });
      const refined = project?.diagrams?.[sectionId]?.chosen;
      const history = store.get().histories[sectionId];
      if (!refined || !history) return;
      store.set({ histories: { ...store.get().histories, [sectionId]: pushHistory(history, refined) } });
      saver.schedule(sectionId, refined);
      toast('Đã hoàn thiện. Các chỗ bạn sửa được giữ nguyên.', { kind: 'ok' });
    },

    openQuestions: () => askQuestions(),

    async openExport() {
      await saver.flush();
      if (!alive) return;
      openExport({
        project: store.get().project,
        sectionId: store.get().sectionId,
        onDownload: async ({ format, sections, transparent }) => {
          await saver.flush();
          showBusy({ label: 'Đang xuất tệp...' });
          try {
            const { blob, filename } = await api.exportFile(projectId(), { format, sections, transparent });
            downloadBlob(blob, filename);
          } catch (error) {
            toast(error.message, { kind: 'error' });
            throw error;
          } finally {
            if (!store.get().busy) hideBusy();
          }
        },
      });
    },

    toggleDrawer(open = !drawerOpen) {
      drawerOpen = open && window.matchMedia(NARROW).matches;
      root.classList.toggle('drawer-open', drawerOpen);
      scrim.hidden = !drawerOpen;
      drawerButton.setAttribute('aria-expanded', String(drawerOpen));
      if (drawerOpen) sourceEl.querySelector('button')?.focus();
    },
  };

  const ctx = { store, api, fontSet, actions };
  const source = sourcePane.mount(sourceEl, ctx);
  const canvas = canvasPane.mount(canvasEl, ctx);
  const pickers = pickersPane.mount(pickersEl, ctx);
  const inspector = inspectorPane.mount(inspectorEl, ctx);

  drawerButton.addEventListener('click', () => actions.toggleDrawer());
  exportButton.addEventListener('click', () => actions.openExport());
  scrim.addEventListener('click', () => actions.toggleDrawer(false));
  sourceEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) {
      actions.toggleDrawer(false);
      drawerButton.focus();
    }
  });

  function render(state) {
    if (!alive || !state.project) return;
    docName.textContent = state.project.document.title || 'Dự án';
    docName.title = docName.textContent;
    source.update(state);
    canvas.update(state);
    pickers.update(state);
    inspector.update(state);
  }
  const unsubscribe = store.subscribe(render);
  const uninstallKeys = installKeys(actions);
  const flushOnHide = () => saver.flush();
  window.addEventListener('pagehide', flushOnHide);

  return {
    setRoute(route) {
      const state = store.get();
      const sectionId = route.sectionId && state.project.sections.some((section) => section.id === route.sectionId) ? route.sectionId : null;
      if (route.sectionId && !sectionId) {
        go(`#/p/${encodeURIComponent(state.project.id)}`);
        return;
      }
      if (sectionId !== state.sectionId) {
        saver.flush();
        store.set(selectSection(state, sectionId));
      } else {
        render(state);
      }
      if (!sectionId && window.matchMedia(NARROW).matches) actions.toggleDrawer(true);
      askQuestions();
    },
    destroy() {
      alive = false;
      saver.flush();
      unsubscribe();
      uninstallKeys();
      window.removeEventListener('pagehide', flushOnHide);
      document.querySelectorAll('dialog.questions-dialog, dialog.export-dialog').forEach((dialog) => dialog.close());
    },
  };
}
