import { createStore } from './state.js';
import { createApi } from './api.js';
import { onRoute, go } from './router.js';
import { h, clear } from './ui/dom.js';
import { toast } from './ui/toast.js';
import { showBusy, hideBusy } from './ui/progress.js';
import { mountHome } from './views/home.js';
import { getToken, clearToken, openTokenDialog } from './dialogs/token.js';

const store = createStore({
  health: null,
  project: null,
  sectionId: null,
  histories: {},
  selectedNodeId: null,
  busy: null,
  pendingSave: false,
});

const api = createApi({
  getToken,
  onUnauthorized: () => {
    clearToken();
    openTokenDialog({ onSubmit: () => start() });
  },
});

const app = document.getElementById('app');
const topbarSlot = document.getElementById('topbar-slot');
let renderToken = 0;

function mountProjectPlaceholder(el, ctx, project) {
  const { api, store } = ctx;
  clear(el);
  el.appendChild(h('div', { class: 'home' },
    h('h1', { text: project.document.title || 'Dự án' }),
    h('p', { class: 'lead', text: project.pendingQuestions ? 'AI đang chờ bạn trả lời.' : 'Chọn một phần để vẽ sơ đồ.' })));
  const sections = project.sections ?? [];
  if (sections.length === 0) {
    el.appendChild(h('div', { class: 'home' }, h('p', { class: 'empty', text: 'AI chưa chia phần.' })));
    return;
  }
  const list = h('ul', { class: 'recent' });
  for (const section of sections) {
    list.appendChild(h('li', null, h('span', { text: section.title }), h('span', { class: 'meta', text: `${section.blockIds.length} đoạn` })));
  }
  el.appendChild(h('div', { class: 'home' }, list));
  store.set({ sectionId: sections[0].id });
}

async function renderProject(route) {
  const token = ++renderToken;
  const known = store.get().project;
  if (!known || known.id !== route.projectId) {
    clear(app);
    showBusy({ label: 'Đang tải dự án...' });
    let project;
    try {
      project = await api.getProject(route.projectId);
    } catch (error) {
      hideBusy();
      if (token === renderToken) {
        toast(error.message, { kind: 'error' });
        go('#/');
      }
      return;
    }
    if (token !== renderToken) return;
    hideBusy();
    store.set({ project });
  }
  if (token !== renderToken) return;
  mountProjectPlaceholder(app, { api, store, go }, store.get().project);
}

function render(route) {
  renderToken += 1;
  clear(topbarSlot);
  clear(app);
  if (route.name === 'project') renderProject(route);
  else mountHome(app, { api, store, go });
}

async function start() {
  try {
    const health = await api.health();
    store.set({ health });
    if (health.needsToken && !getToken()) {
      openTokenDialog({ onSubmit: () => start() });
      return;
    }
  } catch (error) {
    toast(error.message, { kind: 'error' });
  }
}

start();
onRoute(render);
