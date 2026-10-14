'use strict';

// Hermes agent bridge: forward a transcribed voice command to a remote Hermes
// Agent API server (the OpenAI-compatible `api_server` platform) and stream the
// reply back as events for the HUD. Nothing is installed locally: the server on
// the other machine runs the agent, this process only speaks HTTPS to it.
//
// Configured from the environment (FRIDAY_AGENT_* from ROOT/.env are read too,
// without overriding real environment variables). With no URL or key the bridge
// is disabled and Friday behaves exactly as before, showing only the transcript.
//
//   FRIDAY_AGENT_URL        base URL, e.g. https://hermes.example.com (or http://host:8642)
//   FRIDAY_AGENT_KEY        bearer token: the server's API_SERVER_KEY
//   FRIDAY_AGENT_MODEL      model id to request (default hermes-agent)
//   FRIDAY_AGENT_SESSION    prefix of the X-Hermes-Session-Id; commands close together
//                           share one session (see conversation.js). Default friday;
//                           set to an empty value for one-shot, stateless runs
//   FRIDAY_AGENT_SESSION_IDLE_S  a pause longer than this starts a new conversation
//                           (default 600)
//   FRIDAY_AGENT_TIMEOUT_S  hard ceiling for a single run in seconds (default 120)
//
// Security: the API server exposes the agent's full toolset, so the bearer key
// is as powerful as the agent itself. Keep it in the 0600 root .env, reach the
// server over HTTPS (or an SSH tunnel), and restrict the tools on the server
// side (a dedicated profile) rather than trusting the client to do it.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MODEL = 'hermes-agent';
const DEFAULT_SESSION = 'friday';
const DEFAULT_TIMEOUT_S = 120;
const DEFAULT_SESSION_IDLE_S = 600;
const ERROR_BODY_CHARS = 300;
const TOOL_LABEL_CHARS = 48;
// Appended to every command. In a long shared session the agent keeps answering
// in whatever language dominates the history, so an English command got a
// Vietnamese reply. A system message does not override that; a note in the
// user turn itself does, and leaves Vietnamese commands answered in Vietnamese.
const REPLY_LANGUAGE_NOTE = '[Voice command. Reply in the language this command is spoken in.]';

/** Read FRIDAY_AGENT_* from ROOT/.env without clobbering real environment variables. */
function loadAgentEnv(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env is fine: the environment may carry everything
  }
  for (const line of text.split('\n')) {
    const match = /^\s*(FRIDAY_AGENT_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function positiveSeconds(value, fallback) {
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/**
 * Incremental Server-Sent Events parser.
 *
 * Hermes streams standard `data:` chunks, a named `hermes.tool.progress` event,
 * and `: keepalive` comments during long tool calls; comments are dropped here.
 * onEvent(name, data) fires once per blank-line-terminated event, so a chunk
 * boundary in the middle of a line never splits an event.
 */
function createSseParser(onEvent) {
  let buffer = '';
  let name = '';
  let data = [];
  const emit = () => {
    if (!name && data.length === 0) return;
    const payload = data.join('\n');
    const event = name || 'message';
    name = '';
    data = [];
    onEvent(event, payload);
  };
  return (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        emit();
        continue;
      }
      if (line.startsWith(':')) continue; // keepalive comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    }
  };
}

/** A short human label for a hermes.tool.progress payload, whose shape is not fixed. */
function toolLabel(payload) {
  let label = '';
  try {
    const obj = JSON.parse(payload);
    label = obj.tool || obj.name || obj.tool_name || obj.label || obj.text || obj.status || '';
  } catch {
    label = payload;
  }
  const clean = String(label).replace(/\s+/g, ' ').trim();
  return clean.slice(0, TOOL_LABEL_CHARS) || 'tool';
}

class HermesAgent extends EventEmitter {
  constructor(options = {}) {
    super();
    loadAgentEnv();
    this.baseUrl = String(options.baseUrl ?? process.env.FRIDAY_AGENT_URL ?? '').replace(/\/+$/, '');
    this.key = options.key ?? process.env.FRIDAY_AGENT_KEY ?? '';
    this.model = options.model ?? process.env.FRIDAY_AGENT_MODEL ?? DEFAULT_MODEL;
    this.session = options.session ?? process.env.FRIDAY_AGENT_SESSION ?? DEFAULT_SESSION;
    this.sessionIdleMs =
      positiveSeconds(options.sessionIdleSeconds ?? process.env.FRIDAY_AGENT_SESSION_IDLE_S, DEFAULT_SESSION_IDLE_S) * 1000;
    this.timeoutMs = positiveSeconds(options.timeoutSeconds ?? process.env.FRIDAY_AGENT_TIMEOUT_S, DEFAULT_TIMEOUT_S) * 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.controller = null;
  }

  /** True when a server is configured; otherwise ask() is a no-op. */
  get enabled() {
    return Boolean(this.baseUrl && this.key);
  }

  /** Abandon the in-flight run, if any (a new wake or quit). */
  cancel() {
    if (this.controller) this.controller.abort();
  }

  close() {
    this.cancel();
  }

  headers(session) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${this.key}`,
    };
    if (session) headers['X-Hermes-Session-Id'] = session;
    return headers;
  }

  /**
   * Send one voice command as a single user turn of `session` (empty: a
   * stateless run) and stream the reply. Emits: start {id}, delta {id, text}, tool {id, label}, done {id, text},
   * error {id, message}. A newer ask() cancels the previous one silently.
   */
  async ask(id, text, session = this.session) {
    if (!this.enabled || !text) return;
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const current = () => this.controller === controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = JSON.stringify({ model: this.model, stream: true, messages: [{ role: 'user', content: `${text}\n\n${REPLY_LANGUAGE_NOTE}` }] });
    this.emit('start', { id });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers(session),
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        if (current()) this.fail(id, `Hermes ${res.status}: ${detail.trim().slice(0, ERROR_BODY_CHARS) || res.statusText}`);
        return;
      }
      await this.consume(id, res, current);
    } catch (err) {
      if (current()) {
        const reason = controller.signal.aborted ? 'agent run timed out' : err.message;
        this.fail(id, reason);
      }
    } finally {
      clearTimeout(timer);
      if (current()) this.controller = null;
    }
  }

  async consume(id, res, current) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let answer = '';
    let sawDone = false;
    const parse = createSseParser((event, payload) => {
      if (event === 'hermes.tool.progress') {
        this.emit('tool', { id, label: toolLabel(payload) });
        return;
      }
      if (payload === '[DONE]') {
        sawDone = true;
        return;
      }
      let frame;
      try {
        frame = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = frame.choices?.[0]?.delta;
      const piece = delta?.content;
      if (typeof piece === 'string' && piece) {
        answer += piece;
        this.emit('delta', { id, text: piece });
      }
    });
    for (;;) {
      const { value, done } = await reader.read();
      if (!current()) return; // superseded mid-stream: say nothing
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
      if (sawDone) break;
    }
    this.emit('done', { id, text: answer });
  }

  fail(id, message) {
    this.emit('error', { id, message: String(message || 'agent failed') });
  }
}

module.exports = { HermesAgent, REPLY_LANGUAGE_NOTE, createSseParser, toolLabel, loadAgentEnv };
