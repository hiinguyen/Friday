// Voice command state, fed by the listener's capture/transcript events.
//
// phase: idle -> listening (recording after the wake word) -> transcribing
//        -> done | empty | error | rejected (not the enrolled voice)
//        | unclear (too little speech to tell who it was)
// Times are in ms on any monotonic clock (the HUD passes performance.now()).

// Longest a command may stay busy without progress: 15 s capture plus two
// API attempts. Guards against a lost terminal event pinning the HUD open.
export const COMMAND_WATCHDOG_MS = 60000;
export const IDLE_DISMISS_MS = 12000;
export const REJECTED_DISMISS_MS = 3500; // someone else said "Friday": power down soon

const WAKE_PREFIX = /^\s*(?:hey[\s,.!?-]+)?friday\b[\s,.!?-]*/i;

/** Live deltas are shown as they arrive; drop a "Friday" in case some of the wake word was recorded. */
export const stripWakePhrase = (text) => text.replace(WAKE_PREFIX, '').trim();

/**
 * When the HUD should power down: IDLE_DISMISS_MS after the wake or the last
 * speech, but only REJECTED_DISMISS_MS after a voice was rejected, and a
 * stranger who keeps talking must not keep it up. A newer wake (voice or CLI)
 * restores the normal window.
 */
export function dismissDeadline(command, wakeAt, lastSpeechAt) {
  if (command.phase === 'rejected' && command.updatedAt >= wakeAt) return command.updatedAt + REJECTED_DISMISS_MS;
  return Math.max(wakeAt, lastSpeechAt) + IDLE_DISMISS_MS;
}

export class CommandTracker {
  constructor() {
    this.latestId = 0; // survives reset(), so late events of a past capture stay stale
    this.reset();
  }

  reset() {
    this.id = 0;
    this.phase = 'idle';
    this.raw = '';
    this.text = '';
    this.error = '';
    this.updatedAt = 0;
  }

  /** True while the HUD must stay up: a command is being recorded or transcribed. */
  get busy() {
    return this.phase === 'listening' || this.phase === 'transcribing';
  }

  /** Returns false (and changes nothing) for events of an older capture. */
  accept(id) {
    if (id < this.latestId || (id === this.latestId && id !== this.id)) return false;
    if (id > this.latestId) {
      this.reset();
      this.latestId = id;
      this.id = id;
    }
    return true;
  }

  onCapture({ id, state, error }, now = 0) {
    if (!this.accept(id)) return false;
    this.updatedAt = now;
    if (state === 'listening') this.phase = 'listening';
    else if (state === 'processing') this.phase = 'transcribing';
    else if (state === 'empty' || state === 'cancelled') this.phase = 'empty';
    else if (state === 'unclear') this.phase = 'unclear';
    else if (state === 'rejected') {
      this.phase = 'rejected';
      this.error = error ?? '';
    }
    return true;
  }

  onTranscript({ id, delta, text, raw, final, error }, now = 0) {
    if (!this.accept(id)) return false;
    this.updatedAt = now;
    if (error) {
      this.phase = 'error';
      this.error = error;
    } else if (final) {
      this.raw = raw ?? text;
      this.text = text;
      this.phase = text ? 'done' : 'empty';
    } else if (delta) {
      this.phase = 'transcribing';
      this.raw += delta;
      this.text = stripWakePhrase(this.raw);
    }
    return true;
  }

  /** Fail a command that made no progress for COMMAND_WATCHDOG_MS; true if it just expired. */
  expire(now) {
    if (!this.busy || now - this.updatedAt <= COMMAND_WATCHDOG_MS) return false;
    this.phase = 'error';
    this.error = 'speech link timed out';
    return true;
  }
}
