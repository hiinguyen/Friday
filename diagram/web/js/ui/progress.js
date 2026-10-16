import { h, clear } from './dom.js';

export function showBusy({ label = '', onCancel = null } = {}) {
  const el = document.getElementById('busy');
  if (!el) return;
  clear(el);
  el.hidden = false;
  el.appendChild(h('div', { class: 'busy-bar' }));
  const info = h('div', { class: 'busy-info' }, h('span', { text: label }));
  if (onCancel) info.appendChild(h('button', { class: 'button ghost', type: 'button', onClick: onCancel }, 'Huỷ'));
  el.appendChild(info);
}

export function hideBusy() {
  const el = document.getElementById('busy');
  if (!el) return;
  el.hidden = true;
  clear(el);
}
