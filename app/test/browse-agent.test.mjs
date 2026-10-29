import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { BrowserAgent } = require('../src/browse/agent.js');
const { StalePage } = require('../src/browse/page.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

const CLICK = { id: 'e1', kind: 'click', label: 'Go', role: 'button', value: '', node: 20 };
const WAIT = { id: 'wait', kind: 'wait', label: 'Wait for the page to update' };
const FILL = { id: 'e1', kind: 'fill', label: 'Search', role: 'textbox', value: '', node: 10 };

const baseState = (actions = [CLICK, WAIT]) => ({
  url: 'https://example.test/',
  title: 'Search',
  text: 'Search',
  actions,
  scroll: { y: 0 },
  marker: ['m'],
  page_key: ['k'],
  guards: {},
  fingerprint: 'f',
});

const click = () => ({ choice: 'e1', operation: 'CLICK', target: '1', confidence: 1, targetConfidence: 1, model: 'test', credits: 42, ms: 5 });
const fill = () => ({ choice: 'e1', operation: 'TYPE_TEXT', target: '1', confidence: 1, targetConfidence: 1, model: 'test', credits: 42, ms: 5 });
const wait = () => ({ choice: 'wait', operation: 'WAIT', target: null, confidence: 1, model: 'test', credits: null, ms: 5 });
const done = () => ({ choice: 'DONE', operation: 'DONE', target: null, confidence: 1, model: 'test', credits: 43, ms: 5 });

/** Answer from a decision queue; the last entry repeats. */
function seq(items) {
  let index = 0;
  return async () => {
    const item = items[Math.min(index, items.length - 1)];
    index += 1;
    return typeof item === 'function' ? item() : item;
  };
}

/** A scripted page: fresh from a queue (default true), observe/act from functions. */
function fakePage(script = {}) {
  const calls = { fresh: 0, observe: 0, act: [], activate: 0 };
  let observeIndex = 0;
  let freshIndex = 0;
  const freshQueue = script.fresh ?? [];
  return {
    calls,
    async fresh() {
      calls.fresh += 1;
      const value = freshQueue[freshIndex];
      freshIndex += 1;
      return value === undefined ? true : value;
    },
    async observe() {
      const index = observeIndex;
      observeIndex += 1;
      calls.observe += 1;
      const result = script.observe ? script.observe(index, calls) : script.state;
      if (result instanceof Error) throw result;
      return result;
    },
    async act(action, state, text) {
      calls.act.push({ id: action.id, kind: action.kind, text });
      const outcome = script.act ? script.act(action, calls, text) : undefined;
      if (outcome instanceof Error) throw outcome;
    },
    async activate() {
      calls.activate += 1;
    },
  };
}

function makeAgent({ script = {}, decides, fields, env = {}, now } = {}) {
  const page = fakePage(script);
  const chrome = { connection: async () => ({}) };
  const agent = new BrowserAgent({
    env: { JEV_API_KEY: 'sk_test', ...env },
    chrome,
    openPage: async () => page,
    decideImpl: decides,
    fieldTextImpl: fields,
    now,
  });
  return { agent, page };
}

test('a stale decision is dropped before any mutation, and the page is re-observed', async () => {
  let decideCalls = 0;
  const { agent, page } = makeAgent({
    script: { state: baseState(), fresh: [false, true, true] },
    decides: async () => {
      decideCalls += 1;
      return done();
    },
  });
  const result = await agent.run('find it');
  assert.equal(result.status, 'done');
  assert.equal(page.calls.act.length, 0, 'nothing was executed');
  assert.equal(page.calls.observe, 2, 'the loop re-observed before deciding');
  assert.equal(decideCalls, 1);
});

test('generated text is reused for an identical retry context', async () => {
  let helperCalls = 0;
  let actCalls = 0;
  const { agent, page } = makeAgent({
    script: {
      state: baseState([FILL, WAIT]),
      act: () => {
        actCalls += 1;
        return actCalls === 1 ? new StalePage('changed before input') : undefined;
      },
    },
    decides: seq([fill(), fill(), done()]),
    fields: async () => {
      helperCalls += 1;
      return { text: 'book', model: 'test', ms: 1 };
    },
  });
  const steps = [];
  const result = await agent.run('find it', { onStep: (step) => steps.push(step) });
  assert.equal(result.status, 'done');
  assert.equal(helperCalls, 1, 'the same context reuses the generated text');
  assert.equal(page.calls.act.length, 2, 'the first act was stale, the second ran');
  assert.deepEqual(steps.map((step) => step.text), ['book']);
  assert.equal(steps[0].operation, 'TYPE_TEXT');
});

test('a changed field value regenerates the text', async () => {
  const first = baseState([FILL, WAIT]);
  const second = baseState([{ ...FILL, value: 'Zurich' }, WAIT]);
  let helperCalls = 0;
  let actCalls = 0;
  const { agent } = makeAgent({
    script: {
      observe: (index) => (index === 0 ? first : second),
      fresh: [true, true, false],
      act: () => {
        actCalls += 1;
        return actCalls === 1 ? new StalePage('changed before input') : undefined;
      },
    },
    decides: seq([fill(), fill(), done()]),
    fields: async () => {
      helperCalls += 1;
      return { text: `t${helperCalls}`, model: 'test', ms: 1 };
    },
  });
  const result = await agent.run('find it');
  assert.equal(result.status, 'done');
  assert.equal(helperCalls, 2, 'the changed field context is not reused');
});

test('waits do not trigger the no-progress stop, but three unchanged actions do', async () => {
  const waiting = makeAgent({ script: { state: baseState([WAIT]) }, decides: seq([wait(), wait(), wait(), wait(), wait(), done()]) });
  const awaited = await waiting.agent.run('wait for it');
  assert.equal(awaited.status, 'done');
  assert.equal(awaited.actions, 5);

  const clicking = makeAgent({ script: { state: baseState([CLICK, WAIT]) }, decides: seq([click(), click(), click()]) });
  const stuck = await clicking.agent.run('click it');
  assert.equal(stuck.status, 'blocked');
  assert.equal(stuck.reason, 'no progress');
  assert.equal(clicking.page.calls.act.length, 3);
});

test('a page that never settles after an action still keeps the action in history', async () => {
  const { agent, page } = makeAgent({
    script: {
      observe: (index) => (index === 1 ? new StalePage('Page did not settle') : baseState([CLICK, WAIT])),
    },
    decides: seq([click(), done()]),
  });
  const steps = [];
  const result = await agent.run('click it', { onStep: (step) => steps.push(step) });
  assert.deepEqual([result.status, result.reason], ['blocked', 'Page did not settle']);
  assert.equal(result.actions, 1, 'the executed action stayed in history');
  assert.equal(steps.length, 1, 'onStep reported it exactly once');
  assert.equal(page.calls.act.length, 1);
});

test('DONE on a fresh page stops as done and shows the tab', async () => {
  const { agent, page } = makeAgent({ script: { state: baseState() }, decides: seq([done()]) });
  const result = await agent.run('done now');
  assert.deepEqual([result.status, result.reason], ['done', '']);
  assert.equal(result.title, 'Search');
  assert.equal(result.credits, 43);
  assert.equal(page.calls.activate, 1, 'the owned tab is brought forward');
  assert.equal(page.calls.act.length, 0);
});

test('BLOCKED stops with the generic reason', async () => {
  const blocked = () => ({ choice: 'BLOCKED', operation: 'BLOCKED', target: null, confidence: 1, model: 'test', credits: null, ms: 5 });
  const { agent } = makeAgent({ script: { state: baseState() }, decides: seq([blocked()]) });
  const result = await agent.run('impossible');
  assert.deepEqual([result.status, result.reason], ['blocked', 'Jev chose BLOCKED']);
});

test('cancel while the decision is pending resolves null and never acts', async () => {
  const page = fakePage({ state: baseState() });
  let decideStarted;
  const started = new Promise((resolve) => {
    decideStarted = resolve;
  });
  const agent = new BrowserAgent({
    env: { JEV_API_KEY: 'sk_test' },
    chrome: { connection: async () => ({}) },
    openPage: async () => page,
    decideImpl: ({ signal }) => {
      decideStarted();
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort);
      });
    },
    fieldTextImpl: async () => ({ text: 'x', model: 'test', ms: 1 }),
    now: () => 0,
  });
  const running = agent.run('cancel me');
  await started;
  agent.cancel();
  assert.equal(await running, null);
  assert.equal(page.calls.act.length, 0);
  assert.equal(page.calls.activate, 0, 'a cancelled run leaves the tab as it is');
});

test('a dropdown error ends the run without a retry', async () => {
  const { agent, page } = makeAgent({
    script: { state: baseState([CLICK, WAIT]), act: () => new Error('Dropdown execution was not confirmed; inspect before retrying.') },
    decides: seq([click()]),
  });
  const result = await agent.run('pick a value');
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /Dropdown execution/);
  assert.equal(page.calls.act.length, 1, 'a browser mutation is never retried');
});

test('TYPE_TEXT without a text model ends blocked with the configuration reason', async () => {
  const { agent, page } = makeAgent({ script: { state: baseState([FILL, WAIT]) }, decides: seq([fill()]) });
  const result = await agent.run('type it');
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /TYPE_TEXT needs a text model: set FRIDAY_BROWSE_TEXT_URL/);
  assert.equal(page.calls.act.length, 0);
});

test('the action budget stops at sixty actions', async () => {
  const { agent } = makeAgent({ script: { state: baseState([WAIT]) }, decides: seq([wait()]), now: () => 0 });
  const result = await agent.run('wait forever');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'action budget');
  assert.equal(result.actions, 60);
  assert.equal(result.decisions, 60);
});

test('the decision budget stops at one hundred and twenty decisions', async () => {
  const { agent, page } = makeAgent({
    script: { state: baseState([FILL, WAIT]), act: () => new StalePage('changed before input') },
    decides: seq([fill()]),
    fields: async () => ({ text: 'x', model: 'test', ms: 1 }),
    now: () => 0,
  });
  const result = await agent.run('never settles');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'decision budget');
  assert.equal(result.decisions, 120);
  assert.equal(result.actions, 0);
  assert.equal(page.calls.act.length, 120);
});

test('the time budget is checked before any decision', async () => {
  let calls = 0;
  const { agent, page } = makeAgent({
    script: { state: baseState([WAIT]) },
    decides: seq([wait()]),
    now: () => (calls++ === 0 ? 0 : 120001),
  });
  const result = await agent.run('too long');
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'time budget');
  assert.equal(page.calls.act.length, 0);
});

test('disabledReason names the first reason the browser agent cannot run', () => {
  assert.equal(new BrowserAgent({ env: { FRIDAY_BROWSE: 'off' } }).disabledReason, 'FRIDAY_BROWSE=off');
  assert.equal(new BrowserAgent({ env: {} }).disabledReason, 'set JEV_API_KEY');
  assert.equal(new BrowserAgent({ env: { JEV_API_KEY: 'k', FRIDAY_BROWSE_START_URL: 'http://x/' } }).disabledReason, 'FRIDAY_BROWSE_START_URL must be https');
  const on = new BrowserAgent({ env: { JEV_API_KEY: 'k' } });
  assert.equal(on.disabledReason, '');
  assert.equal(on.enabled, true);
  assert.equal(on.startUrl, 'https://www.google.com/');
  assert.equal(on.timeoutMs, 120000);
  assert.equal(new BrowserAgent({ env: { FRIDAY_BROWSE_TIMEOUT_S: '30' } }).timeoutMs, 30000);
});

test('a freshness check that hits a navigating page re-observes instead of failing the run', async () => {
  let checks = 0;
  const { agent, page } = makeAgent({ script: { state: baseState() }, decides: seq([done]) });
  page.fresh = async () => {
    checks += 1;
    if (checks === 1) throw new StalePage('Document changed during evaluation');
    return true;
  };
  const result = await agent.run('find it');
  assert.equal(result.status, 'done');
  assert.equal(page.calls.observe, 2, 'the stale check led to a new observation');
});

test('cancel while Chrome is still connecting resolves null without opening a tab', async () => {
  let opened = 0;
  const agent = new BrowserAgent({
    env: { JEV_API_KEY: 'sk_test' },
    chrome: { connection: () => new Promise(() => {}) }, // the Allow prompt is never answered
    openPage: async () => {
      opened += 1;
    },
  });
  const run = agent.run('find it');
  await flush();
  agent.cancel();
  assert.equal(await run, null);
  assert.equal(opened, 0);
});

test('a tab that finishes opening after cancel is closed and never acted on', async () => {
  let finishOpen;
  const page = fakePage({ state: baseState() });
  page.close = async () => {
    page.calls.closed = true;
  };
  const agent = new BrowserAgent({
    env: { JEV_API_KEY: 'sk_test' },
    chrome: { connection: async () => ({}) },
    openPage: () => new Promise((resolve) => {
      finishOpen = () => resolve(page);
    }),
    decideImpl: seq([click]),
  });
  const run = agent.run('find it');
  await flush();
  agent.cancel();
  assert.equal(await run, null);
  finishOpen();
  await flush();
  assert.equal(page.calls.closed, true);
  assert.equal(page.calls.observe, 0);
  assert.equal(page.calls.act.length, 0);
});
