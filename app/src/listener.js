'use strict';

// Supervises listener/wake.py and turns its JSON-lines stdout into events.

const { PythonWorker } = require('./worker');

const VOICEPRINT_STATES = new Set(['armed', 'unusable', 'off']);

class WakeListener extends PythonWorker {
  constructor({ backoffMs } = {}) {
    super('wake.py', { name: 'listener', backoffMs });
  }

  onEvent(event, line) {
    switch (event.type) {
      case 'ready':
        // voiceprint: 'armed' (enrolled voice only), 'unusable' (every command rejected) or 'off' (any voice).
        this.emit('ready', { voiceprint: VOICEPRINT_STATES.has(event.voiceprint) ? event.voiceprint : 'off' });
        break;
      case 'wake':
        this.emit('wake', event.conf);
        break;
      case 'level':
        this.emit('level', event.value);
        break;
      case 'error':
        this.emit('error', event.message);
        break;
      case 'capture':
      case 'transcript':
        this.emit(event.type, event);
        break;
      default:
        super.onEvent(event, line);
    }
  }
}

module.exports = { WakeListener };
