// The gesture badge: what gesture mode sees, in the corner of the screen.

const POSE_LABEL = { open: 'OPEN HAND', fist: 'GRAB', other: 'HAND', none: 'NO HAND' };
const ARROW = { left: '◀', right: '▶' };

const body = document.body;
const badge = document.querySelector('.badge');
const pose = document.querySelector('.pose');
const ws = document.querySelector('.ws');
const flash = document.querySelector('.flash');

window.friday.on('badge:state', (state) => {
  body.dataset.mode = state.mode;
  body.dataset.pose = state.pose;
  pose.textContent = state.mode === 'starting' ? 'CAMERA' : (POSE_LABEL[state.pose] ?? 'HAND');
  ws.textContent = state.workspace ? `WS ${state.workspace}` : '';
});

window.friday.on('badge:action', ({ direction }) => {
  flash.textContent = ARROW[direction] ?? '';
  // Restart the animation even when two swipes come in quick succession.
  badge.classList.remove('flashing');
  void badge.offsetWidth;
  badge.classList.add('flashing');
});
