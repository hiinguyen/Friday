// Voice command state, fed by the listener's capture/transcript events.
//
// phase: idle -> listening (recording after the wake word) -> transcribing
//        -> done | empty | error | rejected (not the enrolled voice)
//        | unclear (too little speech to tell who it was)
// Times are in ms on any monotonic clock (the HUD passes performance.now()).

// Longest a command may stay busy without progress: 15 s capture plus two
// API attempts. Guards against a lost terminal event pinning the HUD open.
export const COMMAND_WATCHDOG_MS = 60000;
// An agent run is longer: the remote Hermes may think and call tools for a
// while, and the bridge only streams a line when something changes.
export const AGENT_WATCHDOG_MS = 150000;
// Speaking a reply sends no progress until it ends; a lost 'done' (the voice
// worker crashed) must still not hold the HUD up forever.
export const SPEECH_WATCHDOG_MS = 300000;
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

/**
 * The HUD log line for a Jev routing event ({phase: 'routing'} while Jev
 * decides, then {route, confidence, reason?, routeError?}), or null if the
 * event says nothing about routing. The agent route is shown as HERMES.
 */
export function routeLog({ phase, route, confidence = 0, reason, routeError }) {
  if (phase === 'routing') return { text: 'Jev routing', kind: 'info', value: '' };
  if (!route) return null;
  const label = route === 'agent' ? 'HERMES' : route.replace(/_/g, ' ').toUpperCase();
  if (reason === 'error') return { text: `Jev: ${routeError || 'failed'}`, kind: 'warn', value: label };
  const value = `${label} ${Math.round(confidence * 100)}%`;
  if (reason === 'unsure') return { text: 'Jev unsure', kind: 'warn', value };
  return { text: 'Jev route', kind: 'ok', value };
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
    // The agent (remote Hermes) side: idle -> working -> done | error.
    this.agent = 'idle';
    this.tool = '';
    this.route = ''; // 'routing' while Jev decides, then the route it picked
    this.reply = '';
    this.speaking = false; // the reply is being read aloud
    this.updatedAt = 0;
  }

  /** True while recording, transcribing, or waiting on the agent: work that can time out. */
  get working() {
    return this.phase === 'listening' || this.phase === 'transcribing' || this.agent === 'working';
  }

  /** True while the HUD must stay up: working, or reading the reply aloud. */
  get busy() {
    return this.working || this.speaking;
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

  /** Fail a command that made no progress for its watchdog; true if it just expired. */
  expire(now) {
    if (this.speaking && now - this.updatedAt > SPEECH_WATCHDOG_MS) this.speaking = false;
    if (!this.working) return false;
    const window = this.agent === 'working' ? AGENT_WATCHDOG_MS : COMMAND_WATCHDOG_MS;
    if (now - this.updatedAt <= window) return false;
    this.phase = 'error';
    this.agent = 'idle';
    this.error = this.reply ? 'agent link timed out' : 'speech link timed out';
    return true;
  }

  /**
   * The remote agent's lifecycle: 'working' (thinking or calling a tool),
   * 'done' or 'error'. Counts as progress so the watchdog resets.
   */
  onAgent({ id, state, tool, error, phase, route }, now = 0) {
    if (!this.accept(id)) return false;
    this.updatedAt = now;
    if (phase === 'routing') this.route = 'routing';
    if (route) this.route = route;
    if (state === 'error') {
      this.agent = 'error';
      this.error = error ?? '';
    } else if (state) {
      this.agent = state;
      if (state === 'working' && tool) this.tool = tool;
    }
    return true;
  }

  /** The reply being read aloud: 'speaking', then 'done' (also when cut short); 'skipped' is not English. */
  onSpeech({ id, state }, now = 0) {
    if (!this.accept(id)) return false;
    this.updatedAt = now;
    if (state === 'speaking') this.speaking = true;
    else if (state === 'done') this.speaking = false;
    return true;
  }

  /** The agent's reply, streamed as deltas then confirmed with the final text. */
  onReply({ id, delta, text, final, error }, now = 0) {
    if (!this.accept(id)) return false;
    this.updatedAt = now;
    if (error) {
      this.agent = 'error';
      this.error = error;
    } else if (final) {
      this.reply = text ?? this.reply;
      this.agent = 'done';
      this.tool = '';
    } else if (delta) {
      this.reply += delta;
    }
    return true;
  }
}
