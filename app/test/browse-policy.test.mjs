import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { actionSpace, buildDecisionRequest, decide, validateChoice } = require('../src/browse/policy.js');
const { MAX_ACTIONS, MAX_DECISIONS, NEXT_ACTION, TARGET } = require('../src/browse/questions.js');

const SAFETY = 'Never pay, buy, book, place an order, send or post a message, delete anything, or change account or security settings: choose BLOCKED instead. Never enter passwords, card numbers or other personal data that the goal does not state.';

function page() {
  return {
    url: 'https://example.test/',
    title: 'Search',
    text: 'Search',
    scroll: { y: 0 },
    actions: [
      { id: 'e1', kind: 'fill', label: 'Search', role: 'textbox', value: '', node: 10 },
      { id: 'e2', kind: 'click', label: 'Open Search', role: 'textbox', value: '', node: 10 },
      { id: 'e3', kind: 'click', label: 'Go', role: 'button', value: '', node: 20 },
      { id: 'wait', kind: 'wait', label: 'Wait' },
    ],
  };
}

const choice = (ids, selected) => ({
  choice: selected,
  confidence: 1,
  probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jev = (fetchImpl) => ({ url: 'https://jev.example/api/v1/systemone', key: 'sk_test', model: 'jev-test', timeoutMs: 1000, fetchImpl });

test('the instruction texts carry the safety rule and the budgets are pinned', () => {
  assert.ok(NEXT_ACTION.includes(SAFETY), 'NEXT_ACTION carries the safety paragraph');
  assert.ok(TARGET.includes('Choose only an offered element index.'));
  assert.equal(MAX_ACTIONS, 60);
  assert.equal(MAX_DECISIONS, 120);
});

test('actionSpace gives one index per node with operation-specific targets', () => {
  const { elements, targets, controls } = actionSpace(page().actions);
  assert.equal(elements.length, 2, 'two DOM nodes, not four actions');
  assert.deepEqual(elements[0].operations, ['TYPE_TEXT', 'CLICK']);
  assert.equal(targets.TYPE_TEXT['1'].id, 'e1');
  assert.equal(targets.CLICK['1'].id, 'e2');
  assert.equal(targets.CLICK['2'].id, 'e3');
  assert.ok('WAIT' in controls);
});

test('a select node keeps one index and numbers its option targets', () => {
  const actions = [
    { id: 'e1', kind: 'select', label: 'Category → All', role: 'combobox', node: 1, value: 'All', current_value: 'All' },
    { id: 'e2', kind: 'select', label: 'Category → Design', role: 'combobox', node: 1, value: 'Design', current_value: 'All' },
  ];
  const { elements, targets } = actionSpace(actions);
  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0].options.map((o) => o.index), ['1:1', '1:2']);
  assert.equal(targets.SELECT['1:2'].id, 'e2');
});

test('all heads ride one request and only the chosen head executes', async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return jsonResponse({
      model: 'test',
      answers: {
        operation: choice(Object.keys(body.questions.operation.criteria), 'TYPE_TEXT'),
        type_text_target: choice(Object.keys(body.questions.type_text_target.criteria), '1'),
        click_target: { choice: 'invented' },
      },
    });
  };
  // Two editable fields, so both a TYPE_TEXT and a CLICK target head are asked.
  const state = page();
  state.actions.push({ id: 'e4', kind: 'fill', label: 'City', role: 'textbox', value: '', node: 30 });
  const decision = await decide({ state, goal: 'Find a book', history: [], jev: jev(fetchImpl), fetchImpl });
  assert.equal(calls.length, 1, 'one Jev call for operation and every target head');
  assert.deepEqual(Object.keys(calls[0].questions).sort(), ['click_target', 'operation', 'type_text_target']);
  assert.equal(decision.operation, 'TYPE_TEXT');
  assert.equal(decision.target, '1');
  assert.equal(decision.choice, 'e1');
  assert.equal(decision.model, 'test');
  assert.ok(Number.isInteger(decision.ms) && decision.ms >= 0);
});

test('a target head with one candidate is not asked, and its sole candidate is used', async () => {
  let sentKeys;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sentKeys = Object.keys(body.questions).sort();
    return jsonResponse({
      model: 'test',
      answers: { operation: choice(Object.keys(body.questions.operation.criteria), 'TYPE_TEXT') },
    });
  };
  // page() has one editable field, so type_text_target would have one criterion.
  const decision = await decide({ state: page(), goal: 'Find a book', history: [], jev: jev(fetchImpl), fetchImpl });
  assert.deepEqual(sentKeys, ['click_target', 'operation'], 'a one-option choice is never sent');
  assert.equal(decision.choice, 'e1');
  assert.equal(decision.target, '1');
  assert.equal(decision.targetConfidence, null);
});

test('a CLICK operation cannot consume a target that only type_text_target knows', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({
      model: 'test',
      answers: {
        operation: choice(Object.keys(body.questions.operation.criteria), 'CLICK'),
        type_text_target: choice(['1'], '1'),
        click_target: choice(Object.keys(body.questions.click_target.criteria), '999'),
      },
    });
  };
  await assert.rejects(decide({ state: page(), goal: 'Find a book', history: [], jev: jev(fetchImpl), fetchImpl }), /Invalid Jev response/);
});

test('an unused target head that is malformed does not fail the decision', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({
      model: 'test',
      answers: {
        operation: choice(Object.keys(body.questions.operation.criteria), 'TYPE_TEXT'),
        type_text_target: choice(['1'], '1'),
        click_target: { choice: 'invented', probabilities: { z: 1 } },
      },
    });
  };
  const decision = await decide({ state: page(), goal: 'Find a book', history: [], jev: jev(fetchImpl), fetchImpl });
  assert.equal(decision.choice, 'e1');
});

test('target questions carry current values, state and both rule sets', async () => {
  const p = page();
  p.actions.unshift({ id: 'toggle', kind: 'click', label: 'Free cancellation', node: 30, role: 'checkbox', checked: 'true', selected: false });
  let seen;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen = body.questions.click_target;
    return jsonResponse({
      model: 'test',
      answers: {
        operation: choice(Object.keys(body.questions.operation.criteria), 'CLICK'),
        click_target: choice(Object.keys(seen.criteria), '3'),
      },
    });
  };
  const decision = await decide({ state: p, goal: 'Search with free cancellation', history: [], jev: jev(fetchImpl), fetchImpl });
  assert.equal(decision.choice, 'e3');
  assert.equal(seen.criteria['1'].checked, 'true');
  assert.equal(seen.criteria['1'].selected, false);
  assert.equal(seen.criteria['1'].role, 'checkbox');
  assert.equal(typeof seen.instructions, 'string');
  assert.ok(seen.instructions.includes(NEXT_ACTION), 'the target question carries the next-step rules');
  assert.ok(seen.instructions.includes(TARGET), 'the target question carries the target rules');
});

test('question instructions are strings: JevStation caps the structured form', () => {
  const { body } = buildDecisionRequest(page(), 'Find a book', [], 'jev-test');
  assert.equal(typeof body.questions.operation.instructions, 'string');
  assert.ok(body.questions.operation.instructions.includes(NEXT_ACTION));
  assert.ok(body.questions.operation.instructions.includes('Find a book'), 'the goal rides along');
  assert.equal(typeof body.questions.click_target.instructions, 'string');
});

test('buildDecisionRequest sends the page, elements and last ten actions', () => {
  const history = Array.from({ length: 12 }, (_v, i) => ({ action: `a${i}`, kind: 'click', text: null, page_changed: false }));
  const { body, operations, targets, controls } = buildDecisionRequest(page(), 'Find a book', history, 'jev-test');
  assert.equal(body.model, 'jev-test');
  assert.deepEqual(body.state.page, { url: 'https://example.test/', title: 'Search', text: 'Search' });
  assert.equal(body.state.recent_actions.length, 10);
  assert.equal(body.state.recent_actions[0].action, 'a2');
  assert.ok(operations.DONE && operations.BLOCKED);
  assert.ok(targets.CLICK && controls.WAIT);
});

test('validateChoice enforces the choice and its probabilities', () => {
  const ids = { a: 1, b: 1 };
  const ok = { choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } };
  assert.equal(validateChoice(ok, ids), ok);
  assert.throws(() => validateChoice({ ...ok, choice: 'x' }, ids), /Invalid Jev response/);
  assert.throws(() => validateChoice({ ...ok, probabilities: { a: NaN, b: 0 } }, ids), /Invalid Jev response/);
  assert.throws(() => validateChoice({ ...ok, probabilities: { a: 1 } }, ids), /Invalid Jev response/);
  assert.throws(() => validateChoice({ ...ok, probabilities: { a: 1, b: -1 } }, ids), /Invalid Jev response/);
  assert.throws(() => validateChoice({ choice: 'b', confidence: 1, probabilities: { a: 1, b: 0 } }, ids), /Invalid Jev response/);
  assert.throws(() => validateChoice({ ...ok, confidence: 5 }, ids), /Invalid Jev response/);
  assert.throws(() => validateChoice({ choice: 'a', confidence: NaN }, ids), /Invalid Jev response/);
  const noProbabilities = { choice: 'a', confidence: 0.9 };
  assert.equal(validateChoice(noProbabilities, ids), noProbabilities, 'probabilities are optional');
});
