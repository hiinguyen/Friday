import { h, clear } from '../ui/dom.js';

const TOKEN_KEY = 'diagram.token';
let memoryToken = null;

export function getToken() {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    return stored ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(value) {
  memoryToken = value || null;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* without storage the token lives in memory only */
  }
}

export function clearToken() {
  setToken(null);
}

let dialog = null;
let handler = null;

function ensureDialog() {
  if (dialog) return dialog;
  const input = h('input', { type: 'password', id: 'token-input', autocomplete: 'current-password', 'aria-label': 'Mã truy cập' });
  const form = h('form', { method: 'dialog' },
    h('h2', { text: 'Nhập mã truy cập' }),
    h('p', { class: 'lead', text: 'Máy chủ này yêu cầu mã truy cập.' }),
    h('div', { class: 'field' }, h('label', { for: 'token-input', text: 'Mã truy cập' }), input),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'button primary', type: 'submit' }, 'Tiếp tục')));
  dialog = h('dialog', { class: 'token-dialog', 'aria-label': 'Mã truy cập' }, form);
  document.body.appendChild(dialog);
  form.addEventListener('submit', () => {
    const value = input.value.trim();
    if (value === '') return;
    setToken(value);
    dialog.close();
    const run = handler;
    handler = null;
    if (run) run();
  });
  return dialog;
}

export function openTokenDialog({ onSubmit } = {}) {
  handler = onSubmit ?? null;
  const el = ensureDialog();
  const input = el.querySelector('#token-input');
  input.value = getToken() ?? '';
  if (!el.open) el.showModal();
  input.focus();
  input.select();
}

export function closeTokenDialog() {
  if (dialog && dialog.open) dialog.close();
  clear(dialog?.querySelector('#token-input'));
}
