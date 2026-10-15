'use strict';

// Supervises listener/hands.py, the camera hand tracker, and turns its
// JSON-lines stdout into events. It runs only while gesture mode is on.

const { PythonWorker } = require('./worker');

const POSES = new Set(['open', 'fist', 'other', 'none']);
const DIRECTIONS = new Set(['left', 'right']);

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
        if (POSES.has(event.pose)) this.emit('hand', event.pose);
        else super.onEvent(event, line);
        break;
      case 'gesture':
        if (POSES.has(event.pose) && DIRECTIONS.has(event.direction)) {
          this.emit('gesture', { pose: event.pose, direction: event.direction });
        } else super.onEvent(event, line);
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
