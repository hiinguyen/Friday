'use strict';

// Supervises listener/wake.py and turns its JSON-lines stdout into events.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'listener', 'wake.py');
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const HEALTHY_RUN_MS = 60000;
const VOICEPRINT_STATES = new Set(['armed', 'unusable', 'off']);

const pythonPath = () => process.env.FRIDAY_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');

class WakeListener extends EventEmitter {
  constructor({ backoffMs = RESTART_BACKOFF_MS } = {}) {
    super();
    this.backoffMs = backoffMs;
    this.child = null;
    this.stopped = false;
    this.failures = 0;
    this.restartTimer = null;
  }

  start() {
    clearTimeout(this.restartTimer);
    if (this.child) return;
    this.stopped = false;
    const startedAt = Date.now();
    const child = spawn(pythonPath(), ['-u', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      console.error(`[listener] ${line}`);
    });

    // A failed spawn emits 'error' and possibly no 'exit'; a crash emits 'exit'.
    // Either way, schedule exactly one restart for this child.
    let handled = false;
    const onDown = (reason) => {
      if (handled) return;
      handled = true;
      this.child = null;
      if (this.stopped) return;
      if (Date.now() - startedAt > HEALTHY_RUN_MS) this.failures = 0;
      const delay = this.backoffMs[Math.min(this.failures, this.backoffMs.length - 1)];
      this.failures += 1;
      this.emit('error', `${reason}; restarting in ${delay}ms`);
      this.restartTimer = setTimeout(() => this.start(), delay);
    };
    child.on('error', (err) => onDown(`cannot start listener: ${err.message}`));
    child.on('exit', (code, signal) => onDown(`listener exited (code=${code} signal=${signal})`));
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.error(`[listener] unparseable output: ${line}`);
      return;
    }
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
        console.error(`[listener] unknown event: ${line}`);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.child) this.child.kill('SIGTERM');
  }
}

module.exports = { WakeListener };
