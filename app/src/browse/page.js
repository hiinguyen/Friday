'use strict';

// One owned background tab in the user's Chrome: open it, read the page as one
// atomic state, guard every decision against the state it was made from, and
// execute only the operation the policy picked.
//
// Everything here is a port of REF/jev_ultrafast/browser.py (MIT, Copyright (c)
// 2026 Browser Use). The model never supplies a selector, coordinate or script:
// positions and nodes come from the observation, and the executor rechecks the
// target immediately before it types or clicks.

/* Ported from browser-use/jev-ultrafast (MIT, Copyright (c) 2026 Browser Use). */

const crypto = require('node:crypto');
const util = require('node:util');
const { MARKER, READ_STATE } = require('./snapshot');

const VIEW_WIDTH = 1120;
const VIEW_HEIGHT = 780;
const NAV_TIMEOUT_MS = 15000;
const POLL_MS = 20;
const OBSERVE_ATTEMPTS = 10;
const WAIT_MS = 100;
const SCROLL_X = 550;
const SCROLL_Y = 650;
const SCROLL_DELTA = 560;
// Chrome's Ctrl+A on Linux and Windows; the executor never sends other keys.
const SELECT_ALL_MODIFIER = 2;

/** The decision no longer refers to the observed page. Safe to re-observe. */
class StalePage extends Error {
  constructor(message) {
    super(message);
    this.name = 'StalePage';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compare only what the policy can see, so animation does not force a new decision. */
function fingerprint(state) {
  const content = [state.url, state.text, state.actions, state.scroll];
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** After text input into a combobox, wait for visible suggestions; otherwise two frames or 50 ms. */
function afterInputExpression(action) {
  return `(action => new Promise(resolve => {
      const field=window.__jevFast?.nodes.get(action.node);
      const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
      let frames=0, stopped=false;
      const finish=()=>{stopped=true;resolve()};
      setTimeout(finish,autocomplete ? 200 : 50);
      const ready=()=>{
        if (stopped) return;
        const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
          .split(/\\s+/).filter(Boolean);
        const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
        const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
        if (++frames>=2 && (!autocomplete || options.some(e=>{
          const r=e.getBoundingClientRect();
          return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
            e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
        }))) finish();
        else requestAnimationFrame(ready);
      };
      requestAnimationFrame(ready);
    }))(${JSON.stringify(action)})`;
}

/**
 * Resolve the target's current geometry and hit-test it. Code-owned node IDs
 * refer to actual observed elements, never model-generated selectors. The
 * select branch performs the mutation in the page, as in the reference.
 */
function targetExpression(action) {
  return `(action => {
      const e=window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
      if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
      const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
      if (!e.contains(document.elementFromPoint(x,y))) return null;
      if (action.kind==='select') {
        if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
            !o.disabled && !o.closest('optgroup[disabled]'))) return null;
        e.value=action.value;
        e.dispatchEvent(new Event('input',{bubbles:true}));
        e.dispatchEvent(new Event('change',{bubbles:true}));
      }
      return {x,y};
    })(${JSON.stringify(action)})`;
}

/** The scoped guard a click or select depends on: document state, viewport, form and nearby context. */
function guardExpression(node) {
  return `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`;
}

class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.afterInput = null;
  }

  /** Create the background tab, size it and load `url`; waits for the document to be complete. */
  static async open(cdp, url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, targetId, sessionId);
    await page.call('Emulation.setDeviceMetricsOverride', {
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Keep rAF and menus rendering in the owned tab without activating the user's tab.
    await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.call('Page.navigate', { url });
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await page.evaluate('document.readyState')) === 'complete') break;
      await sleep(POLL_MS);
    }
    return page;
  }

  call(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const response = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (response?.exceptionDetails) throw new StalePage('Document changed during evaluation');
    return response?.result?.value;
  }

  /** One atomic read of the page: url, title, visible text, indexed actions, guards and marker. */
  async observe() {
    if (this.afterInput) {
      const action = this.afterInput;
      this.afterInput = null;
      // Read-only and after execution was logged, even when navigation interrupts it.
      try {
        await this.call('Runtime.evaluate', { expression: afterInputExpression(action), awaitPromise: true, returnByValue: true });
      } catch {
        // A navigation during the wait is not an error: the next read finds the new page.
      }
    }
    for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt += 1) {
      try {
        return await this.snapshot();
      } catch (err) {
        if (!(err instanceof StalePage) || attempt === OBSERVE_ATTEMPTS - 1) throw err;
      }
      await sleep(POLL_MS);
    }
    throw new StalePage('Page did not settle');
  }

  async snapshot() {
    const info = await this.evaluate(READ_STATE);
    if (info === null || info === undefined) throw new StalePage('Document is navigating');
    info.fingerprint = fingerprint(info);
    return info;
  }

  /**
   * Whether the page still matches this decision. A click or select compares the
   * scoped guard, so unrelated visible updates do not invalidate it; everything
   * else compares the whole-page marker.
   */
  async fresh(state, action = null) {
    if (action && (action.kind === 'click' || action.kind === 'select')) {
      const node = action.node;
      if (!Number.isInteger(node)) return false;
      const current = await this.evaluate(guardExpression(node));
      // JSON object keys are strings, so the guard of node 7 is guards['7'].
      return util.isDeepStrictEqual(current, [state.page_key, state.guards?.[String(node)]]);
    }
    return util.isDeepStrictEqual(await this.evaluate(MARKER), state.marker);
  }

  /**
   * Execute one observed action. Throws StalePage when the page moved (safe to
   * re-observe), or a plain Error for a dropdown whose result cannot be
   * confirmed (never retried). Every other kind of failure is a plain Error too.
   */
  async act(action, state, text = null) {
    if (!(await this.fresh(state, action))) throw new StalePage('Page changed since this decision. Observe again.');
    if (action.kind === 'wait') {
      await sleep(WAIT_MS);
      return;
    }
    if (action.kind === 'scroll') {
      await this.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: SCROLL_X,
        y: SCROLL_Y,
        deltaX: 0,
        deltaY: action.delta,
      });
      this.afterInput = action;
      return;
    }
    if (!Number.isInteger(action.node)) throw new Error('Invalid observed node');
    let target;
    try {
      target = await this.evaluate(targetExpression(action));
    } catch (err) {
      // The select's change event may already have fired; a retry could double it.
      if (action.kind === 'select') throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
      throw err;
    }
    if (target === null || target === undefined) {
      if (action.kind === 'select') throw new Error('Dropdown execution was not confirmed; inspect before retrying.');
      throw new StalePage('Target changed or is covered. Observe again.');
    }
    if (action.kind !== 'select') {
      const { x, y } = target;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
      if (action.kind === 'fill') {
        const modifiers = SELECT_ALL_MODIFIER;
        await this.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers, commands: ['selectAll'] });
        await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers });
        await this.call('Input.insertText', { text });
      }
    }
    this.afterInput = action;
  }

  /** Bring the owned tab forward, so the user sees the result at the end of a run. */
  async activate() {
    await this.cdp.send('Target.activateTarget', { targetId: this.targetId });
  }

  /** Close the owned tab; errors are ignored (the tab may already be gone). */
  async close() {
    const targetId = this.targetId;
    this.targetId = null;
    try {
      await this.cdp.send('Target.closeTarget', { targetId });
    } catch {
      // already closed
    }
  }
}

module.exports = { Page, StalePage, fingerprint };
