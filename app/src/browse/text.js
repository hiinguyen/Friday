'use strict';

// The text helper: TYPE_TEXT is the only operation that needs a model, and this
// is the only place a value is written. It talks to any OpenAI-compatible
// /chat/completions endpoint, and its reply must parse as a small JSON object.
//
// Ported from `field_context` and `field_text` in REF/jev_ultrafast/model.py
// (MIT, Copyright (c) 2026 Browser Use).
//
//   FRIDAY_BROWSE_TEXT_URL      base URL, no default (e.g. https://api.openai.com/v1,
//                               or http://127.0.0.1:8080/v1 for a model on this machine)
//   FRIDAY_BROWSE_TEXT_KEY      bearer key for that endpoint (optional on this machine)
//   FRIDAY_BROWSE_TEXT_MODEL    model id
//   FRIDAY_BROWSE_TEXT_EXTRA    optional JSON object merged into the body (never
//                               model/messages/response_format)

/* Ported from browser-use/jev-ultrafast (MIT, Copyright (c) 2026 Browser Use). */

const { TEXT_VALUE } = require('./questions');

const MAX_PAGE_CHARS = 6000;
const RECENT_ACTIONS = 6;
const MAX_TEXT_CHARS = 2000;
const MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 20000;
// A text request is not a browser mutation, so a throttled or overloaded
// provider may be retried; a server error is not.
const RETRY_STATUS = new Set([429, 503, 529]);
const RETRY_DELAYS = [500, 1000];
const PROTECTED_KEYS = ['model', 'messages', 'response_format'];
const INVALID_VALUE = 'Text helper returned no valid field value; nothing typed.';
// Plain http is only for a server on this machine (llama-server, Ollama): the
// page text and the key never cross the network unencrypted.
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/** TYPE_TEXT needs a text model; the loop ends the run with this reason. */
class TextConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextConfigError';
  }
}

/** Wait `ms`, or less when `signal` aborts first. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** The endpoint, key, model and provider-specific extras, from the environment. */
function textConfig(env = process.env) {
  const raw = env.FRIDAY_BROWSE_TEXT_EXTRA;
  let extra = {};
  let warning = '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extra = { ...parsed };
        for (const key of PROTECTED_KEYS) delete extra[key];
      } else {
        warning = 'FRIDAY_BROWSE_TEXT_EXTRA is not a JSON object, ignored';
      }
    } catch {
      warning = 'FRIDAY_BROWSE_TEXT_EXTRA is not a JSON object, ignored';
    }
  }
  return {
    url: (env.FRIDAY_BROWSE_TEXT_URL || '').replace(/\/+$/, ''),
    key: env.FRIDAY_BROWSE_TEXT_KEY || '',
    model: env.FRIDAY_BROWSE_TEXT_MODEL || '',
    extra,
    warning,
  };
}

/** Why TYPE_TEXT cannot run ('' when it can). */
function textDisabledReason(config) {
  const local = LOOPBACK.test(config?.url ?? '');
  if (config?.url && !local && !config.url.startsWith('https://')) {
    return 'FRIDAY_BROWSE_TEXT_URL must be https, or http on this machine';
  }
  if (!config?.url || (!config.key && !local) || !config.model) {
    return 'set FRIDAY_BROWSE_TEXT_URL, FRIDAY_BROWSE_TEXT_KEY and FRIDAY_BROWSE_TEXT_MODEL';
  }
  return '';
}

/** What the text model sees: the goal, the field, visible page text and recent actions. */
function fieldContext(goal, action, state, history) {
  return {
    goal,
    field: { label: action.label ?? null, role: action.role ?? null, value: action.value ?? null },
    page: { title: state.title, text: String(state.text ?? '').slice(0, MAX_PAGE_CHARS) },
    recent_actions: history.slice(-RECENT_ACTIONS).map((entry) => ({ action: entry.action ?? null, text: entry.text ?? null })),
  };
}

function invalidValue() {
  return new Error(INVALID_VALUE);
}

/** The reply content must parse as exactly {"text": "<non-empty, <=2000 chars>"}. */
function parseFieldValue(content) {
  let output;
  try {
    output = JSON.parse(content);
  } catch {
    throw invalidValue();
  }
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).length !== 1 || !Object.hasOwn(output, 'text')) {
    throw invalidValue();
  }
  const value = output.text;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS) throw invalidValue();
  return value;
}

/** One attempt, with its own timeout that does not disturb the caller's signal. */
async function postOnce(config, body, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.key) headers.Authorization = `Bearer ${config.key}`;
    return await fetchImpl(`${config.url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw new Error('Text model timed out');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** POST, retrying only a throttled or overloaded provider (at most twice). */
async function postChat(config, body, options) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await postOnce(config, body, options);
    if (RETRY_STATUS.has(res.status) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt], options.signal);
      if (options.signal?.aborted) throw new Error('Text model aborted');
      continue;
    }
    return res;
  }
}

/**
 * Ask a small model for the field value. Resolves to {text, model, ms}.
 * Throws TextConfigError when no usable endpoint is configured, and
 * Error('Text helper returned no valid field value; nothing typed.') otherwise.
 */
async function fieldText(context, { config, signal, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const reason = textDisabledReason(config ?? {});
  if (reason) throw new TextConfigError(`TYPE_TEXT needs a text model: ${reason}`);
  const body = {
    ...config.extra,
    model: config.model,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: TEXT_VALUE },
      { role: 'user', content: JSON.stringify(context) },
    ],
  };
  const startedAt = Date.now();
  const res = await postChat(config, body, { fetchImpl, signal, timeoutMs });
  if (!res.ok) throw new Error(`Text model ${res.status}`);
  let content;
  try {
    const result = await res.json();
    content = result?.choices?.[0]?.message?.content;
  } catch {
    throw invalidValue();
  }
  const text = parseFieldValue(content);
  return { text, model: config.model, ms: Date.now() - startedAt };
}

module.exports = { fieldContext, fieldText, textConfig, textDisabledReason, TextConfigError };
