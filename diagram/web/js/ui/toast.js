import { h } from './dom.js';

// Stacked messages at the bottom centre. An optional action adds one button (for example
// "Thử lại") that runs once and closes the toast.
export function toast(message, { kind = 'info', timeout = 5000, action = null } = {}) {
  const container = document.getElementById('toasts');
  if (!container) return null;
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-text', text: message }));
  if (action) {
    el.appendChild(h('button', {
      class: 'button ghost toast-action', type: 'button',
      onClick: () => { el.remove(); action.onClick(); },
    }, action.label));
  }
  container.appendChild(el);
  if (timeout > 0) setTimeout(() => el.remove(), action ? Math.max(timeout, 10000) : timeout);
  return el;
}
