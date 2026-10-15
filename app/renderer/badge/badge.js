// The gesture badge: what gesture mode sees, in the corner of the screen.

import { actionLabel, handLabel } from '../gesture/labels.js';

const body = document.body;
const badge = document.querySelector('.badge');
const hand = document.querySelector('.hand');
const ws = document.querySelector('.ws');
const flash = document.querySelector('.flash');

window.friday.on('badge:state', (state) => {
  body.dataset.mode = state.mode;
  body.dataset.hand = state.fingers === null ? 'none' : 'seen';
  body.dataset.carrying = String(state.carrying);
  hand.textContent = handLabel(state);
  ws.textContent = state.workspace ? `WS ${state.workspace}` : '';
});

window.friday.on('badge:action', (action) => {
  flash.textContent = actionLabel(action);
  flash.dataset.action = action.action;
  // Restart the animation even when two commands come in quick succession.
  badge.classList.remove('flashing');
  void badge.offsetWidth;
  badge.classList.add('flashing');
});
