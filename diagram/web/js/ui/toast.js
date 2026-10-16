import { h } from './dom.js';

export function toast(message, { kind = 'info', timeout = 5000 } = {}) {
  const container = document.getElementById('toasts');
  if (!container) return null;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', text: message });
  container.appendChild(el);
  if (timeout > 0) setTimeout(() => el.remove(), timeout);
  return el;
}
