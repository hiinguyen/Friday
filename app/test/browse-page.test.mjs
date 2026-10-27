import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { CdpConnection, readDevToolsUrl } = require('../src/browse/cdp.js');
const { MARKER, READ_STATE } = require('../src/browse/snapshot.js');
const { Page, StalePage, fingerprint } = require('../src/browse/page.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'browse.html');
const chromeMissing = spawnSync('google-chrome-stable', ['--version']).status !== 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A CDP stub that records calls and answers from a script. */
function fakeCdp(handler) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      return Promise.resolve(handler(method, params, sessionId));
    },
  };
}

const state = (overrides = {}) => ({
  url: 'https://example.test/',
  title: 'Search',
  text: 'Search',
  actions: [],
  marker: ['m'],
  page_key: ['k'],
  guards: {},
  scroll: { y: 0 },
  ...overrides,
});

test('snapshot is the verbatim browser script, with the escape sequence intact', () => {
  assert.ok(READ_STATE.includes('split(/\\s+/)'), 'the split regex keeps a single backslash');
  assert.ok(MARKER.includes(READ_STATE));
  assert.ok(READ_STATE.includes('__jevFast'));
});

test('open sends the five setup calls in order, session-scoped', async () => {
  const cdp = fakeCdp((method) => {
    if (method === 'Target.createTarget') return { targetId: 't1' };
    if (method === 'Target.attachToTarget') return { sessionId: 's1' };
    if (method === 'Runtime.evaluate') return { result: { value: 'complete' } };
    return {};
  });
  const page = await Page.open(cdp, 'https://example.test/');
  assert.deepEqual(
    cdp.calls.slice(0, 5).map((c) => c.method),
    ['Target.createTarget', 'Target.attachToTarget', 'Emulation.setDeviceMetricsOverride', 'Emulation.setFocusEmulationEnabled', 'Page.navigate'],
  );
  assert.equal(cdp.calls[0].sessionId, undefined, 'createTarget is browser-level');
  assert.equal(cdp.calls[1].sessionId, undefined, 'attachToTarget is browser-level');
  assert.deepEqual(cdp.calls.slice(2, 5).map((c) => c.sessionId), ['s1', 's1', 's1']);
  assert.equal(cdp.calls[4].params.url, 'https://example.test/');
  assert.equal(cdp.calls[2].params.width, 1120);
  assert.equal(cdp.calls[3].params.enabled, true);
  assert.equal(page.targetId, 't1');
});

test('observe retries after a snapshot that is not ready', async () => {
  const expected = state({ actions: [{ id: 'e1', kind: 'wait', label: 'Wait' }] });
  let reads = 0;
  const cdp = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate' && params.expression === READ_STATE) {
      reads += 1;
      return { result: { value: reads === 1 ? null : expected } };
    }
    return {};
  });
  const observed = await new Page(cdp, 't1', 's1').observe();
  assert.equal(observed, expected);
  assert.equal(reads, 2);
  assert.equal(typeof observed.fingerprint, 'string');
  assert.equal(observed.fingerprint, fingerprint(expected));
});

test('act refuses a stale page before any Input call', async () => {
  const cdp = fakeCdp((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: [['other'], ['g']] } };
    return {};
  });
  const page = new Page(cdp, 't1', 's1');
  const action = { id: 'e1', kind: 'click', node: 10, label: 'Go' };
  await assert.rejects(page.act(action, state({ guards: { 10: ['g'] } })), (err) => err.name === 'StalePage');
  assert.ok(!cdp.calls.some((c) => c.method.startsWith('Input.')), 'nothing was executed');
});

test('a select whose evaluation throws raises a plain error, never StalePage', async () => {
  const cdp = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      if (params.expression === MARKER) return { result: { value: ['m'] } };
      if (params.expression.includes('pageKey')) return { result: { value: [['k'], ['g']] } };
      return { exceptionDetails: { text: 'Execution context destroyed' } };
    }
    return {};
  });
  const page = new Page(cdp, 't1', 's1');
  const action = { id: 'e1', kind: 'select', node: 5, value: 'Design', label: 'Category -> Design' };
  await assert.rejects(page.act(action, state({ guards: { 5: ['g'] } })), (err) => {
    assert.notEqual(err.name, 'StalePage');
    assert.match(err.message, /Dropdown execution/);
    return true;
  });
});

test('fill clicks the centre, selects all and inserts the text', async () => {
  const cdp = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      if (params.expression === MARKER) return { result: { value: ['m'] } };
      if (params.expression.includes('pageKey')) return { result: { value: [['k'], ['g']] } };
      return { result: { value: { x: 12, y: 34 } } };
    }
    return {};
  });
  const page = new Page(cdp, 't1', 's1');
  const action = { id: 'e1', kind: 'fill', node: 7, value: 'Zurich', label: 'City' };
  await page.act(action, state({ guards: { 7: ['g'] } }), 'London');
  const inputs = cdp.calls.filter((c) => c.method.startsWith('Input.'));
  assert.deepEqual(inputs.map((c) => c.method), [
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
  ]);
  const [press, release, down, up, insert] = inputs.map((c) => c.params);
  assert.deepEqual([press.type, press.x, press.y, press.button, press.clickCount], ['mousePressed', 12, 34, 'left', 1]);
  assert.deepEqual([release.type, release.x, release.y], ['mouseReleased', 12, 34]);
  assert.equal(down.type, 'keyDown');
  assert.equal(down.key, 'a');
  assert.equal(down.modifiers, 2);
  assert.deepEqual(down.commands, ['selectAll']);
  assert.deepEqual([up.type, up.key], ['keyUp', 'a']);
  assert.deepEqual(insert, { text: 'London' });
  assert.equal(page.afterInput, action, 'the next observe waits for the input to settle');
});

test('a wait sleeps without touching Input, and never arms the after-input wait', async () => {
  const cdp = fakeCdp((method, params) => {
    if (method === 'Runtime.evaluate' && params.expression === MARKER) return { result: { value: ['m'] } };
    return {};
  });
  const page = new Page(cdp, 't1', 's1');
  const action = { id: 'wait', kind: 'wait', label: 'Wait for the page to update' };
  const before = Date.now();
  await page.act(action, state({ marker: ['m'] }), null);
  assert.ok(Date.now() - before >= 90, 'wait sleeps about 100 ms');
  assert.ok(!cdp.calls.some((c) => c.method.startsWith('Input.')));
  assert.equal(page.afterInput, null);
});

test('fingerprint tracks values and actions, and ignores everything else', () => {
  const base = state({ text: 'hi', actions: [{ id: 'e1', value: 'a' }] });
  assert.equal(fingerprint(base), fingerprint(structuredClone(base)));
  assert.equal(fingerprint(base), fingerprint({ ...structuredClone(base), extra: 'ignored' }), 'a screenshot or other field is not part of the fingerprint');
  const changed = structuredClone(base);
  changed.actions[0].value = 'b';
  assert.notEqual(fingerprint(base), fingerprint(changed));
});

/** Poll until Chrome has written DevToolsActivePort. */
async function waitForDevToolsUrl(dir) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      return readDevToolsUrl({ chromeDir: dir });
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(100);
    }
  }
}

const FORM_HTML = `
  <form><p id="price">Total $10</p>
  <button type="button" id="buy">Buy</button>
  <label>Search <input id="query" role="combobox" aria-controls="suggestions" value="Zurich"></label>
  <div role="listbox" id="suggestions"></div>
  <label><input id="check" type="checkbox">Enabled</label>
  <label><input id="radio" type="radio">Choice</label>
  <input id="readonly" aria-label="Read only" readonly>
  <input id="secret" type="password" value="never expose this">
  <button id="off" disabled>Disabled</button>
  <select id="category" aria-label="Category">
    <option>All</option><option>Design</option><option disabled>Unavailable</option>
  </select></form><aside id="unrelated">News</aside>
`;

test('real Chrome runs the freshness and execution guards', { skip: chromeMissing && 'google-chrome-stable not installed', timeout: 180000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'friday-browse-'));
  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });
  let cdp = null;
  try {
    cdp = new CdpConnection({ url: await waitForDevToolsUrl(dir) });
    await cdp.open();
    const page = await Page.open(cdp, `file://${FIXTURE}`);

    // A moved target keeps its decision: geometry is resolved just before input.
    let state = await page.observe();
    let action = state.actions.find((a) => a.label === 'Continue');
    assert.ok(action, 'the fixture exposes the Continue button');
    await page.evaluate("document.querySelector('#target').style.transform='translateX(200px)'");
    assert.equal(await page.fresh(state), true, 'movement still counts as fresh');
    await page.act(action, state);
    assert.equal(await page.evaluate('window.clicks'), 1, 'the moved target was clicked at its new place');

    // Offscreen text is not part of the observed state.
    await page.evaluate("document.querySelector('#outside').textContent='Updated outside the viewport'");
    assert.equal(await page.fresh(state), true, 'unrelated offscreen text does not invalidate');

    const mutations = {
      'visible context': "document.querySelector('#context').textContent='Cart total: $100'",
      'accessible label': "document.querySelector('#target').setAttribute('aria-label','Delete account')",
      'field value': "document.querySelector('#field').value='London'",
      'checkbox state': "document.querySelector('#toggle').checked=true",
      'disabled': "document.querySelector('#target').disabled=true",
      'read-only': "document.querySelector('#field').readOnly=true",
      'hidden': "document.querySelector('#target').style.display='none'",
      'replaced node': "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
      'dropdown option text': "document.querySelector('select').options[1].text='Coastal'",
    };
    for (const [label, expression] of Object.entries(mutations)) {
      await page.evaluate("document.querySelector('#target').style.display='block'; document.querySelector('#target').disabled=false");
      state = await page.observe();
      await page.evaluate(expression);
      assert.equal(await page.fresh(state), false, `${label} invalidates the decision`);
    }

    // A textless overlay leaves the semantic state alone but must block the click.
    await page.evaluate("document.querySelector('#target').disabled=false; document.querySelector('#target').style.display='block'");
    state = await page.observe();
    action = state.actions.find((a) => a.label === 'Delete account');
    assert.ok(action, 'the aria-label renamed the button');
    await page.evaluate("const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover)");
    assert.equal(await page.fresh(state), true, 'a textless overlay does not change the semantic state');
    await assert.rejects(page.act(action, state), /./, 'the overlay blocks the click');
    assert.equal(await page.evaluate('window.clicks'), 1, 'no second click happened');

    // Native controls expose only supported operations and safe values.
    await page.evaluate(`document.body.innerHTML = ${JSON.stringify(FORM_HTML)}`);
    state = await page.observe();
    const actions = state.actions;
    for (const role of ['checkbox', 'radio']) {
      assert.deepEqual([...new Set(actions.filter((a) => a.role === role).map((a) => a.kind))], ['click'], `${role} is a click action only`);
    }
    assert.ok(actions.some((a) => a.kind === 'fill' && a.label === 'Search'), 'the combobox offers fill');
    assert.ok(actions.some((a) => a.kind === 'click' && a.label === 'Open Search'), 'the combobox also offers opening');
    assert.deepEqual([...new Set(actions.filter((a) => a.label === 'Read only').map((a) => a.kind))], ['click'], 'a read-only field is click only');
    assert.ok(!actions.some((a) => a.value === 'never expose this'), 'the password value never becomes an action');
    assert.ok(!state.text.includes('never expose this'), 'the password value never becomes page text');
    assert.ok(!actions.some((a) => a.label === 'Disabled'), 'a disabled button is absent');
    assert.deepEqual(actions.filter((a) => a.kind === 'select').map((a) => a.value), ['Design'], 'one select per non-selected, enabled option');

    // Executing the observed dropdown option actually selects it.
    const select = actions.find((a) => a.kind === 'select');
    await page.act(select, state);
    assert.equal(await page.evaluate("document.querySelector('#category').value"), 'Design', 'the dropdown selected the observed option');

    // Typing replaces the old value and waits for asynchronous suggestions.
    await page.evaluate("document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'},60))");
    state = await page.observe();
    const field = state.actions.find((a) => a.kind === 'fill');
    assert.equal(field.value, 'Zurich', 'the combobox starts with Zurich');
    await page.act(field, state, 'London');
    state = await page.observe();
    assert.equal(await page.evaluate("document.querySelector('#query').value"), 'London', 'typing replaced the old value');
    assert.ok(state.actions.some((a) => a.role === 'option'), 'the suggestion that appeared on input is observed');

    // Navigation invalidates the old document.
    await page.call('Page.navigate', { url: 'about:blank' });
    let stillFresh = true;
    try {
      stillFresh = await page.fresh(state, field);
    } catch {
      stillFresh = false;
    }
    assert.equal(stillFresh, false, 'navigation invalidates the old document');
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
