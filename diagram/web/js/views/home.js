import { h, clear } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { showBusy, hideBusy } from '../ui/progress.js';

const relative = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
const FILE_ACCEPT = '.txt,.md,.docx,.pptx';

function relativeTime(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const absolute = Math.abs(seconds);
  if (absolute < 60) return relative.format(Math.round(seconds), 'second');
  if (absolute < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mountHome(el, ctx) {
  const { api, store, go } = ctx;
  let tab = 'text';
  let file = null;

  const textarea = h('textarea', { rows: 10, placeholder: 'Dán đoạn văn, ghi chú hoặc dàn ý...', 'aria-label': 'Nội dung văn bản' });
  const fileInput = h('input', { type: 'file', accept: FILE_ACCEPT, class: 'visually-hidden' });
  const fileLabel = h('div', { class: 'drop', role: 'button', tabindex: '0' }, 'Kéo thả tệp vào đây hoặc bấm để chọn tệp');
  const urlInput = h('input', { type: 'url', placeholder: 'https://...', 'aria-label': 'Địa chỉ trang web' });
  const submit = h('button', { class: 'button primary', type: 'submit' }, 'Tạo sơ đồ');
  const panels = {};

  function pickFile(chosen) {
    file = chosen ?? null;
    clear(fileLabel);
    fileLabel.appendChild(h('span', { class: 'file-name', text: file ? file.name : '' }));
    if (file) fileLabel.appendChild(h('span', { text: ` ${formatSize(file.size)}` }));
    else fileLabel.appendChild(document.createTextNode('Kéo thả tệp vào đây hoặc bấm để chọn tệp'));
    refreshSubmit();
  }

  fileLabel.addEventListener('click', () => fileInput.click());
  fileLabel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));
  fileLabel.addEventListener('dragover', (event) => { event.preventDefault(); fileLabel.classList.add('dragging'); });
  fileLabel.addEventListener('dragleave', () => fileLabel.classList.remove('dragging'));
  fileLabel.addEventListener('drop', (event) => {
    event.preventDefault();
    fileLabel.classList.remove('dragging');
    pickFile(event.dataTransfer.files[0]);
  });

  function refreshSubmit() {
    const text = textarea.value.trim();
    const url = urlInput.value.trim();
    submit.disabled = tab === 'text' ? text === '' : tab === 'file' ? !file : url === '';
  }
  textarea.addEventListener('input', refreshSubmit);
  urlInput.addEventListener('input', refreshSubmit);

  function makeTab(id, label) {
    const button = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false', id: `tab-${id}`, onClick: () => select(id) }, label);
    return button;
  }
  const tabButtons = { text: makeTab('text', 'Dán văn bản'), file: makeTab('file', 'Tải tệp'), url: makeTab('url', 'Trang web') };
  panels.text = h('div', { class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-text' }, textarea);
  panels.file = h('div', { class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-file' }, fileLabel, fileInput);
  panels.url = h('div', { class: 'tab-panel', role: 'tabpanel', 'aria-labelledby': 'tab-url' }, urlInput);

  function select(id) {
    tab = id;
    for (const key of Object.keys(tabButtons)) {
      tabButtons[key].setAttribute('aria-selected', String(key === id));
      panels[key].hidden = key !== id;
    }
    refreshSubmit();
  }

  async function submitForm() {
    let loader;
    if (tab === 'text') loader = () => api.createFromText(textarea.value.trim());
    else if (tab === 'file') loader = () => api.createFromFile(file);
    else loader = () => api.createFromUrl(urlInput.value.trim());
    submit.disabled = true;
    showBusy({ label: 'Đang đọc nội dung...' });
    try {
      const project = await loader();
      showBusy({ label: 'AI đang phân tích...' });
      const segmented = await api.segment(project.id, []);
      hideBusy();
      store.set({ project: segmented ?? project });
      go(`#/p/${project.id}`);
    } catch (error) {
      hideBusy();
      toast(error.message, { kind: 'error' });
      submit.disabled = false;
    }
  }

  const recentList = h('ul', { class: 'recent' });
  const recentEmpty = h('p', { class: 'empty', text: 'Chưa có dự án nào.' });

  async function refreshRecent() {
    let projects = [];
    try {
      projects = await api.listProjects();
    } catch {
      projects = [];
    }
    clear(recentList);
    recentEmpty.hidden = projects.length > 0;
    for (const project of projects) {
      const remove = h('button', {
        class: 'button danger', type: 'button', 'aria-label': `Xoá dự án ${project.title}`,
        onClick: async () => {
          if (!window.confirm('Xoá dự án này?')) return;
          try {
            await api.deleteProject(project.id);
            await refreshRecent();
          } catch (error) {
            toast(error.message, { kind: 'error' });
          }
        },
      }, 'Xoá');
      recentList.appendChild(h('li', null,
        h('a', { href: `#/p/${project.id}` }, project.title || 'Không có tiêu đề'),
        h('span', { class: 'badge', text: project.format }),
        h('span', { class: 'meta', text: `${project.diagramCount} sơ đồ` }),
        h('span', { class: 'meta', text: relativeTime(project.updatedAt) }),
        remove));
    }
  }

  const form = h('form', { class: 'card', onSubmit: (event) => { event.preventDefault(); submitForm(); } },
    h('div', { class: 'tabs', role: 'tablist' }, tabButtons.text, tabButtons.file, tabButtons.url),
    panels.text, panels.file, panels.url,
    h('div', { class: 'tab-panel form-actions' }, submit));

  clear(el);
  el.appendChild(h('div', { class: 'home' },
    h('h1', { text: 'Biến văn bản thành sơ đồ' }),
    h('p', { class: 'lead', text: 'Dán nội dung, tải tệp hoặc nhập địa chỉ web. AI sẽ đề xuất sơ đồ, bạn chọn kiểu và chỉnh trực tiếp.' }),
    form,
    h('h2', { class: 'section-title', text: 'Gần đây' }),
    recentEmpty,
    recentList));

  select('text');
  refreshRecent();

  return { update() {} };
}
