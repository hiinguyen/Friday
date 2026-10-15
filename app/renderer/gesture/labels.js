// What gesture mode shows: shared by the badge and the debug view.

// MediaPipe hand landmark pairs to draw the hand's skeleton.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // index
  [5, 9], [9, 10], [10, 11], [11, 12], // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20], // pinky and the palm's edge
];

/** The badge's main label for a gesture state ({mode, fingers, carrying, zooming, zoom, pinched}). */
export function handLabel({ mode, fingers, carrying, zooming, zoom, pinched }) {
  if (mode === 'starting') return 'CAMERA';
  if (zooming) return `ZOOM ${zoom.toFixed(1)}×`;
  if (pinched) return 'PINCH';
  if (fingers === null || fingers === undefined) return carrying ? 'GRABBED' : 'NO HAND';
  if (fingers === 0) return carrying ? 'GRABBED' : 'FIST';
  if (carrying) return `CARRY TO ${fingers}`;
  return fingers === 1 ? '1 FINGER' : `${fingers} FINGERS`;
}

// What a swipe did to the page (gestures.js SWIPES).
const SWIPE_LABELS = { up: '↑ SCROLL', down: '↓ SCROLL', right: '→ BACK', left: '← FORWARD' };

/** The flash for an action: {action: 'switch' | 'carry', workspace} or {action: 'swipe', direction}. */
export function actionLabel({ action, workspace, direction }) {
  return action === 'swipe' ? SWIPE_LABELS[direction] : `→ ${workspace}`;
}
