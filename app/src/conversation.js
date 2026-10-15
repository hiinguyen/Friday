'use strict';

// Which Hermes session a voice command belongs to.
//
// One endless session made every command slower and dragged old context (and
// its language) into unrelated questions, while no session at all broke
// follow-ups like "Friday, what does that mean?". So commands share a session
// while they come close together, like one conversation, and a pause longer
// than the idle window starts a new one. "Friday, new conversation" starts one
// on demand. Long-term memory is the agent's job, not the transcript's.
//
// The current session and the time of its last activity are kept in a small
// JSON file, so restarting Friday mid-conversation does not lose the thread.

const fs = require('node:fs');
const path = require('node:path');

// Whole utterances (after normalize()) that start a new conversation instead of
// being sent to the agent.
const RESET_PHRASES = new Set([
  'new conversation',
  'start a new conversation',
  'start new conversation',
  'new chat',
  'start over',
  'lets start over',
  'reset the conversation',
  'reset conversation',
  'cuộc trò chuyện mới',
  'cuộc hội thoại mới',
  'trò chuyện mới',
  'bắt đầu lại',
  'chuyện khác',
  'nói chuyện khác',
]);

const WAKE_PREFIX = /^(?:hey\s+)?friday\s+/;

function normalize(text) {
  return String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(WAKE_PREFIX, '');
}

/** True when the whole command asks for a new conversation. */
function isResetCommand(text) {
  return RESET_PHRASES.has(normalize(text));
}

const pad = (n) => String(n).padStart(2, '0');

/** A readable, sortable session id in local time: <prefix>-20261014-203105. */
function sessionId(prefix, ms) {
  const d = new Date(ms);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}-${date}-${time}`;
}

class Conversation {
  /**
   * prefix: session id prefix; empty makes every command stateless.
   * idleMs: a pause longer than this starts a new conversation.
   * file: where the current session survives restarts (optional).
   */
  constructor({ prefix, idleMs, file = null, now = Date.now, onError = () => {} }) {
    this.prefix = prefix;
    this.idleMs = idleMs;
    this.file = file;
    this.now = now;
    this.onError = onError;
    this.session = '';
    this.lastAt = 0;
    this.load();
  }

  get stateless() {
    return !this.prefix;
  }

  /** True when a command arriving now would continue the current conversation. */
  get warm() {
    return !this.stateless && Boolean(this.session) && this.now() - this.lastAt <= this.idleMs;
  }

  load() {
    if (!this.file || this.stateless) return;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.onError(`conversation state unreadable, starting fresh: ${err.message}`);
      return;
    }
    // A session of another prefix belongs to another configuration.
    if (typeof state?.session === 'string' && state.session.startsWith(`${this.prefix}-`) && Number.isFinite(state.lastAt)) {
      this.session = state.session;
      this.lastAt = state.lastAt;
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify({ session: this.session, lastAt: this.lastAt })}\n`, { mode: 0o600 });
    } catch (err) {
      this.onError(`conversation state not saved: ${err.message}`);
    }
  }

  /**
   * The session for a command arriving now: the current one if it is still
   * warm, otherwise a new one. fresh says whether the agent starts from scratch.
   */
  begin() {
    if (this.stateless) return { session: '', fresh: true };
    const now = this.now();
    const fresh = !this.session || now - this.lastAt > this.idleMs;
    if (fresh) this.session = sessionId(this.prefix, now);
    this.lastAt = now;
    this.save();
    return { session: this.session, fresh };
  }

  /** The agent finished answering: the idle window counts from here. */
  touch() {
    if (this.stateless || !this.session) return;
    this.lastAt = this.now();
    this.save();
  }

  /** The next command starts a new conversation. */
  reset() {
    if (this.stateless) return;
    this.session = '';
    this.lastAt = 0;
    this.save();
  }
}

module.exports = { Conversation, isResetCommand, sessionId };
