'use strict';

// The one Jev HTTP call, shared by the intent router (router.js) and the browse
// policy (browse/policy.js). Both ask the same endpoint the same way: one POST,
// a bearer key, a bounded timeout, a JevStation or TypeSafe envelope, and an
// error message a human can read.
//
//   JEV_API_KEY                 bearer key (a JevStation key, or TypeSafe's own)
//   FRIDAY_JEV_URL              endpoint (default JevStation's /api/v1/systemone)
//   FRIDAY_JEV_MODEL            model id (default jev-1.13.0: pinned, so the
//                               answers do not drift with an alias)
//   FRIDAY_JEV_TIMEOUT_S        give up after this many seconds (default 8)

const DEFAULT_URL = 'https://jevstation.com/api/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_TIMEOUT_S = 8;
const ERROR_BODY_CHARS = 200;

/**
 * The Jev settings, from an environment object (main.js fills process.env from
 * the root .env). Only positive numbers are accepted for the timeout.
 */
function jevConfig(env = process.env) {
  const seconds = Number.parseFloat(env.FRIDAY_JEV_TIMEOUT_S);
  const timeoutS = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_S;
  return {
    key: env.JEV_API_KEY ?? '',
    url: env.FRIDAY_JEV_URL || DEFAULT_URL,
    model: env.FRIDAY_JEV_MODEL || DEFAULT_MODEL,
    timeoutMs: timeoutS * 1000,
  };
}

/** Why Jev is off ('' when usable); the bearer key goes nowhere but https. */
function jevDisabledReason({ key, url }) {
  if (!key) return 'set JEV_API_KEY';
  if (!url.startsWith('https://')) return `FRIDAY_JEV_URL must be https, got ${url}`;
  return '';
}

/** A short, human error detail from a failed HTTP response. */
async function errorDetail(res) {
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    const body = JSON.parse(text);
    detail = body.detail?.message ?? body.message ?? body.error?.message ?? text;
  } catch {
    // not JSON: keep the raw text
  }
  return String(detail).trim().slice(0, ERROR_BODY_CHARS) || res.statusText;
}

/** Answers from either JevStation's {data: {...}} envelope or TypeSafe's bare body. */
function parseAnswers(body) {
  const payload = body?.data ?? body;
  if (!payload?.answers || typeof payload.answers !== 'object') throw new Error('Jev returned no answers');
  return {
    answers: payload.answers,
    model: typeof payload.model === 'string' ? payload.model : '',
    credits: Number.isFinite(payload.credits?.remaining) ? payload.credits.remaining : null,
  };
}

/**
 * POST one question set to Jev and return {answers, model, credits}.
 * Throws Error('Jev timed out') on its own timeout, rethrows the abort error
 * when `signal` aborted (callers check signal.aborted), and throws
 * Error('Jev <status>: <detail>') on an HTTP error.
 */
async function askJev({ url, key, body, signal, timeoutMs = DEFAULT_TIMEOUT_S * 1000, fetchImpl = fetch }) {
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
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await errorDetail(res)}`);
    return parseAnswers(await res.json());
  } catch (err) {
    if (timedOut) throw new Error('Jev timed out');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { askJev, errorDetail, jevConfig, jevDisabledReason, parseAnswers };
