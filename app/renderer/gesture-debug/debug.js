// The gesture debug view: the mirrored camera picture hands.py sends, with
// each hand's skeleton drawn over it, the finger count and how close it is to
// firing a command, the pinch that drags swipes, or, while two hands zoom,
// the zoom between them.

import { HAND_CONNECTIONS, handLabel } from '../gesture/labels.js';

const THUMB_TIP = 4;
const INDEX_TIP = 8;
const body = document.body;
const canvas = document.querySelector('canvas');
const count = document.querySelector('.count');
const bar = document.querySelector('.progress span');
const hand = document.querySelector('.hand');
const ws = document.querySelector('.ws');
const tokens = getComputedStyle(document.documentElement);
const color = (name) => tokens.getPropertyValue(name).trim();

const context = canvas.getContext('2d');
const width = canvas.clientWidth;
const height = canvas.clientHeight;
canvas.width = Math.round(width * devicePixelRatio);
canvas.height = Math.round(height * devicePixelRatio);
context.scale(devicePixelRatio, devicePixelRatio);

let pending = null; // the newest frame not drawn yet; older ones are dropped
let drawing = false;

window.friday.on('gesture-debug:state', (state) => {
  body.dataset.mode = state.mode;
  ws.textContent = state.workspace ? `WS ${state.workspace}` : '';
  if (state.mode !== 'on') {
    body.dataset.live = 'false';
    body.dataset.carrying = 'false';
    hand.textContent = handLabel(state);
    count.textContent = '';
    bar.style.width = '0';
    context.clearRect(0, 0, width, height);
  }
});

window.friday.on('gesture-debug:frame', (frame) => {
  pending = frame;
  if (!drawing) drawPending();
});

async function drawPending() {
  drawing = true;
  while (pending) {
    const frame = pending;
    pending = null;
    await draw(frame);
  }
  drawing = false;
}

async function draw(frame) {
  const image = new Image();
  image.src = `data:image/jpeg;base64,${frame.jpeg}`;
  try {
    await image.decode();
  } catch {
    return; // a corrupt frame: the next one replaces it
  }
  if (body.dataset.mode !== 'on') return; // gesture mode ended while it decoded
  context.drawImage(image, 0, 0, width, height);
  const accent = color(frame.carrying ? '--amber' : '--cyan');
  for (const landmarks of frame.hands) drawSkeleton(landmarks, accent);
  if (frame.zooming && frame.hands.length === 2) drawZoomSpan(frame.hands, accent);
  if (frame.pinched && frame.hands.length === 1) drawPinch(frame.hands[0]);
  body.dataset.live = 'true';
  body.dataset.carrying = String(frame.carrying);
  count.textContent = frame.zooming ? `${frame.zoom.toFixed(1)}×` : (frame.fingers ?? '');
  bar.style.width = `${Math.round(frame.progress * 100)}%`;
  hand.textContent = handLabel({ mode: 'on', ...frame });
}

// Between a hand's thumb and index tips: where the zoom and a pinch hold on.
const handle = (landmarks) => [
  ((landmarks[THUMB_TIP][0] + landmarks[INDEX_TIP][0]) / 2) * width,
  ((landmarks[THUMB_TIP][1] + landmarks[INDEX_TIP][1]) / 2) * height,
];

// The point a pinch drags swipes with.
function drawPinch(landmarks) {
  context.fillStyle = color('--amber');
  context.beginPath();
  context.arc(...handle(landmarks), 7, 0, 2 * Math.PI);
  context.fill();
}

// The line the zoom follows (hand_pose.zoom_handle).
function drawZoomSpan(hands, accent) {
  context.lineWidth = 2;
  context.strokeStyle = accent;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(...handle(hands[0]));
  context.lineTo(...handle(hands[1]));
  context.stroke();
  context.setLineDash([]);
}

function drawSkeleton(landmarks, accent) {
  const at = ([x, y]) => [x * width, y * height];
  context.lineWidth = 2;
  context.strokeStyle = accent;
  context.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    context.moveTo(...at(landmarks[a]));
    context.lineTo(...at(landmarks[b]));
  }
  context.stroke();
  context.fillStyle = color('--ink');
  for (const point of landmarks) {
    context.beginPath();
    context.arc(...at(point), 2.5, 0, 2 * Math.PI);
    context.fill();
  }
}
