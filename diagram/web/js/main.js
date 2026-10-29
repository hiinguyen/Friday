import { createStore } from './state.js';
import { createApi } from './api.js';
import { onRoute, go, parseRoute } from './router.js';
import { clear } from './ui/dom.js';
import { toast } from './ui/toast.js';
import { showBusy, hideBusy } from './ui/progress.js';
import { loadBrowserFontSet } from './fonts.js';
import { mountHome } from './views/home.js';
import { mountProject } from './views/project.js';
import { getToken, clearToken, openTokenDialog } from './dialogs/token.js';

const store = createStore({
  health: null,
  project: null,
  sectionId: null,
  histories: {},
  picked: {},
  selectedNodeId: null,
  busy: null,
  pendingSave: false,
});

const app = document.getElementById('app');
const topbarSlot = document.getElementById('topbar-slot');
let view = null;
let renderToken = 0;

// After a 401 the stored token is dropped and the dialog asks again; once a token is entered
// the current screen is rendered again from scratch.
function askToken(error = null) {
  openTokenDialog({ error, onSubmit: () => render(parseRoute(window.location.hash), { force: true }) });
}

const api = createApi({
  getToken,
  onUnauthorized: () => {
    const hadToken = Boolean(getToken());
    clearToken();
    askToken(hadToken ? 'Mã truy cập không đúng.' : null);
  },
});

function teardown() {
  view?.instance?.destroy?.();
  view = null;
  clear(topbarSlot);
  clear(app);
}

async function renderProject(route, force) {
  if (!force && view?.kind === 'project' && view.projectId === route.projectId && view.instance) {
    view.instance.setRoute(route);
    return;
  }
  teardown();
  const token = ++renderToken;
  view = { kind: 'project', projectId: route.projectId, instance: null };
  const known = store.get().project;
  showBusy({ label: 'Đang tải dự án...' });
  try {
    const [project, fontSet] = await Promise.all([
      !force && known?.id === route.projectId ? known : api.getProject(route.projectId),
      loadBrowserFontSet(),
    ]);
    if (token !== renderToken) return;
    store.set({ project, sectionId: null, histories: {}, picked: {}, selectedNodeId: null, busy: null });
    view.instance = mountProject(app, { store, api, fontSet, go, topbarSlot });
    view.instance.setRoute(route);
  } catch (error) {
    if (token !== renderToken || error.status === 401) return;
    toast(error.message, { kind: 'error' });
    go('#/');
  } finally {
    if (token === renderToken) hideBusy();
  }
}

function render(route, { force = false } = {}) {
  if (route.name === 'project') {
    renderProject(route, force);
    return;
  }
  teardown();
  renderToken += 1;
  view = { kind: 'home', instance: mountHome(app, { api, store, go }) };
}

async function start() {
  try {
    const health = await api.health();
    store.set({ health });
    if (health.needsToken && !getToken()) askToken();
  } catch (error) {
    toast(error.message, { kind: 'error' });
  }
  onRoute((route) => render(route));
}

start();
