'use strict';

// Supervises listener/hands.py, the camera hand tracker, and turns its
// JSON-lines stdout into events. It runs only while gesture mode is on.

const { PythonWorker } = require('./worker');

const ACTIONS = new Set(['switch', 'carry']);
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const isFingers = (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 5);
const isWorkspace = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
// hands.py keeps the zoom between 1 and 4; anything outside 1 to 10 is garbage.
const isZoom = (value) => Number.isFinite(value) && value >= 1 && value <= 10;
const isFlag = (value) => typeof value === 'boolean';

// Events: 'ready'; 'hand' {fingers: 0..5 | null, carrying, zooming, pinched};
// 'gesture' {action: 'switch' | 'carry', workspace: 1..5}; 'zoom' {factor};
// 'swipe' {direction: 'up' | 'down' | 'left' | 'right'}; 'frame' (the debug view's
// picture, only with FRIDAY_GESTURE_DEBUG=1); 'error' with a message; 'down'.
class HandWorker extends PythonWorker {
  constructor({ backoffMs } = {}) {
    super('hands.py', { name: 'hands', backoffMs });
  }

  onEvent(event, line) {
    switch (event.type) {
      case 'ready':
        this.emit('ready');
        break;
      case 'hand':
        if (isFingers(event.fingers) && [event.carrying, event.zooming, event.pinched].every(isFlag)) {
          const { fingers, carrying, zooming, pinched } = event;
          this.emit('hand', { fingers, carrying, zooming, pinched });
        } else super.onEvent(event, line);
        break;
      case 'gesture':
        if (ACTIONS.has(event.action) && isWorkspace(event.workspace)) {
          this.emit('gesture', { action: event.action, workspace: event.workspace });
        } else super.onEvent(event, line);
        break;
      case 'zoom':
        if (isZoom(event.factor)) this.emit('zoom', { factor: event.factor });
        else super.onEvent(event, line);
        break;
      case 'swipe':
        if (DIRECTIONS.has(event.direction)) this.emit('swipe', { direction: event.direction });
        else super.onEvent(event, line);
        break;
      case 'frame':
        // Too big to log whole when malformed: name the problem instead.
        if (typeof event.jpeg === 'string') this.emit('frame', event);
        else console.error('[hands] debug frame without a picture');
        break;
      case 'error':
        this.emit('error', event.message);
        break;
      default:
        super.onEvent(event, line);
    }
  }
}

module.exports = { HandWorker };
