'use strict';

// Supervises a Python helper in listener/: its JSON-lines stdout becomes
// onEvent() calls, its stderr goes to the journal, and a crash restarts it
// with backoff. Subclasses map their own event types.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..', '..');
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const HEALTHY_RUN_MS = 60000;

const pythonPath = () => process.env.FRIDAY_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');

// Events: 'down' whenever the child is gone (crash, failed spawn or stop),
// 'error' with the reason when it is going to be restarted.
class PythonWorker extends EventEmitter {
  /**
   * @param {string} script file in listener/
   * @param {{name: string, backoffMs?: number[], input?: boolean}} options
   *   name prefixes its log lines; input opens stdin for send().
   */
  constructor(script, { name, backoffMs = RESTART_BACKOFF_MS, input = false }) {
    super();
    this.script = path.join(ROOT, 'listener', script);
    this.name = name;
    this.backoffMs = backoffMs;
    this.input = input;
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
    const stdin = this.input ? 'pipe' : 'ignore';
    const child = spawn(pythonPath(), ['-u', this.script], { stdio: [stdin, 'pipe', 'pipe'] });
    this.child = child;
    // A child that dies while we write must not crash the shell with EPIPE.
    child.stdin?.on('error', () => {});

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      console.error(`[${this.name}] ${line}`);
    });

    // A failed spawn emits 'error' and possibly no 'exit'; a crash emits 'exit'.
    // Either way, schedule exactly one restart for this child.
    let handled = false;
    const onDown = (reason) => {
      if (handled) return;
      handled = true;
      if (this.child === child) this.child = null;
      this.emit('down');
      if (this.stopped) return;
      if (Date.now() - startedAt > HEALTHY_RUN_MS) this.failures = 0;
      const delay = this.backoffMs[Math.min(this.failures, this.backoffMs.length - 1)];
      this.failures += 1;
      this.emit('error', `${reason}; restarting in ${delay}ms`);
      this.restartTimer = setTimeout(() => this.start(), delay);
    };
    child.on('error', (err) => onDown(`cannot start ${this.name}: ${err.message}`));
    child.on('exit', (code, signal) => onDown(`${this.name} exited (code=${code} signal=${signal})`));
  }

  /** Write one JSON line to the child's stdin; false while it is not running. */
  send(message) {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  handleLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.error(`[${this.name}] unparseable output: ${line}`);
      return;
    }
    this.onEvent(event, line);
  }

  /** Handle one parsed event; `line` is the raw text, for logging. */
  onEvent(_event, line) {
    console.error(`[${this.name}] unknown event: ${line}`);
  }

  /** The helper has nothing to do (and exits on its own): do not restart it. */
  retire() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
  }

  stop() {
    this.retire();
    if (this.child) this.child.kill('SIGTERM');
  }
}

module.exports = { PythonWorker };
