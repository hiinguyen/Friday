'use strict';

// BrowserAgent: the browse loop. Observe the page, ask Jev for one operation and
// its target, do exactly that, and repeat until the goal is done, Jev blocks, a
// budget runs out, or the user moves on.
//
// Ported from Agent.command in REF/jev_ultrafast/agent.py (MIT, Copyright (c)
// 2026 Browser Use). The loop's rules that matter:
//   - a browser mutation is never retried
//   - execution is recorded before its result is observed
//   - a cancelled run never touches the page again
//   - a generated field value survives a stale retry only while its whole
//     helper input is unchanged
//
//   FRIDAY_BROWSE               'off' disables the browser agent
//   FRIDAY_BROWSE_START_URL     where a run opens (default https://www.google.com/)
//   FRIDAY_BROWSE_TIMEOUT_S     stop a run after this many seconds (default 120)

/* Ported from browser-use/jev-ultrafast (MIT, Copyright (c) 2026 Browser Use). */

const util = require('node:util');
const { jevConfig, jevDisabledReason } = require('../jev');
const { Chrome } = require('./cdp');
const { Page, StalePage, fingerprint } = require('./page');
const { MAX_ACTIONS, MAX_DECISIONS } = require('./questions');
const { decide } = require('./policy');
const { fieldContext, fieldText, textConfig } = require('./text');

const DEFAULT_START_URL = 'https://www.google.com/';
const DEFAULT_TIMEOUT_S = 120;

/**
 * `promise`'s value, or null as soon as `signal` aborts. A value that arrives
 * after the abort goes to `onLate` (to release it) and is otherwise dropped.
 */
function untilAborted(promise, signal, onLate = () => {}) {
  if (signal.aborted) {
    promise.then(onLate, () => {});
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.then(onLate, () => {});
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return;
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        if (!signal.aborted) reject(err);
      },
    );
  });
}

function positive(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

class BrowserAgent {
  /**
   * Every collaborator is injectable for tests: `chrome` (a Chrome),
   * `openPage` (Page.open), `decideImpl` (policy.decide), `fieldTextImpl`
   * (text.fieldText) and `now` (a clock).
   */
  constructor({
    env = process.env,
    chrome = new Chrome({ env }),
    openPage = Page.open,
    decideImpl = decide,
    fieldTextImpl = fieldText,
    now = Date.now,
  } = {}) {
    this.env = env;
    this.chrome = chrome;
    this.openPage = openPage;
    this.decideImpl = decideImpl;
    this.fieldTextImpl = fieldTextImpl;
    this.now = now;
    this.jev = jevConfig(env);
    this.text = textConfig(env);
    this.controller = null;
  }

  get startUrl() {
    return this.env.FRIDAY_BROWSE_START_URL || DEFAULT_START_URL;
  }

  get timeoutMs() {
    return positive(this.env.FRIDAY_BROWSE_TIMEOUT_S, DEFAULT_TIMEOUT_S) * 1000;
  }

  /**
   * Why the browser agent is off ('' when on). The text model is not required:
   * a goal that never types works without it, and a TYPE_TEXT decision without
   * one ends the run as blocked with the reason.
   */
  get disabledReason() {
    if (this.env.FRIDAY_BROWSE === 'off') return 'FRIDAY_BROWSE=off';
    const jevReason = jevDisabledReason(this.jev);
    if (jevReason) return jevReason;
    if (!this.startUrl.startsWith('https://')) return 'FRIDAY_BROWSE_START_URL must be https';
    return '';
  }

  get enabled() {
    return !this.disabledReason;
  }

  /** Abandon the run in flight, if any. Starting a new run also does this. */
  cancel() {
    if (this.controller) this.controller.abort();
  }

  /**
   * Run one goal in a new background tab and stay in it until it stops.
   * Resolves to {status, reason, url, title, actions, decisions, credits, ms},
   * or null when cancelled. A cancelled run says nothing to the page again.
   */
  async run(goal, { onStep } = {}) {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const startedAt = this.now();
    // Connecting can wait on Chrome's Allow prompt: a cancel must not wait with it.
    const cdp = await untilAborted(this.chrome.connection(), signal);
    if (!cdp) return null;
    const page = await untilAborted(this.openPage(cdp, this.startUrl), signal, (late) => late.close());
    if (!page) return null;
    const history = [];
    let decisions = 0;
    let credits = null;
    let cachedText = null;

    // The page waits for a changing document to settle; only one that never does throws.
    const observeSettled = () => page.observe({ signal });

    // A check that lands on a navigating document is just a stale page: read it again.
    const isFresh = async () => {
      try {
        return await page.fresh(state);
      } catch (err) {
        if (err instanceof StalePage) return false;
        throw err;
      }
    };

    let state = await observeSettled();
    const finish = async (status, reason) => {
      try {
        await page.activate(); // so the user sees the tab; never closed, they may take over
      } catch {
        // the tab may already be gone
      }
      return { status, reason, url: state.url, title: state.title, actions: history.length, decisions, credits, ms: this.now() - startedAt };
    };

    for (;;) {
      if (signal.aborted) return null;
      if (this.now() - startedAt > this.timeoutMs) return finish('blocked', 'time budget');
      if (decisions >= MAX_DECISIONS) return finish('blocked', 'decision budget');
      if (history.length >= MAX_ACTIONS) return finish('blocked', 'action budget');

      if (!(await isFresh())) {
        state = await observeSettled();
        continue;
      }

      decisions += 1;
      let decision;
      try {
        decision = await this.decideImpl({ state, goal, history, jev: this.jev, signal, fetchImpl: this.jev.fetchImpl });
      } catch (err) {
        if (signal.aborted) return null;
        return finish('blocked', err.message);
      }
      if (signal.aborted) return null;
      if (decision.credits != null) credits = decision.credits;

      if (decision.choice === 'DONE' || decision.choice === 'BLOCKED') {
        if (!(await isFresh())) {
          state = await observeSettled();
          continue;
        }
        const status = decision.choice === 'DONE' ? 'done' : 'blocked';
        return finish(status, status === 'done' ? '' : 'Jev chose BLOCKED');
      }

      const action = state.actions.find((candidate) => candidate.id === decision.choice);
      if (!action) return finish('blocked', `unknown action ${decision.choice}`);

      let text = null;
      if (action.kind === 'fill') {
        if (!(await isFresh())) {
          state = await observeSettled();
          continue;
        }
        const context = fieldContext(goal, action, state, history);
        if (cachedText && util.isDeepStrictEqual(cachedText.context, context)) {
          text = cachedText.text;
        } else {
          try {
            const generated = await this.fieldTextImpl(context, { config: this.text, signal });
            text = generated.text;
            cachedText = { context, text };
          } catch (err) {
            if (signal.aborted) return null;
            return finish('blocked', err.message);
          }
        }
      }

      // A cancelled run must never touch the page again.
      if (signal.aborted) return null;
      try {
        await page.act(action, state, text);
      } catch (err) {
        if (err instanceof StalePage) {
          state = await observeSettled();
          continue;
        }
        return finish('blocked', err.message);
      }
      cachedText = null;

      // Record execution before observing its result; a stale read must not erase it.
      const entry = {
        step: history.length + 1,
        action: action.label,
        kind: action.kind,
        text,
        operation: decision.operation,
        page_changed: null,
        url: state.url,
      };
      history.push(entry);
      if (onStep) onStep({ step: entry.step, label: entry.action, operation: entry.operation, text });

      const before = fingerprint(state);
      try {
        state = await observeSettled();
      } catch (err) {
        return finish('blocked', err.message);
      }
      entry.page_changed = fingerprint(state) !== before;

      const repeated = history.slice(-3);
      if (repeated.length === 3 && repeated.every((item) => item.page_changed === false && item.kind !== 'wait')) {
        return finish('blocked', 'no progress');
      }
    }
  }
}

module.exports = { BrowserAgent };
