'use strict';

// The decision policy: turn one observation into an indexed element table, ask
// Jev which operation to run and which target is right for each operation in
// ONE request, then consume only the chosen operation's target.
//
// Ported from `action_space`, `choose` and `validate_choice` in
// REF/jev_ultrafast/model.py (MIT, Copyright (c) 2026 Browser Use). The model
// never supplies a selector: targets are indices into observed elements, and a
// target head that does not belong to the chosen operation cannot execute.

/* Ported from browser-use/jev-ultrafast (MIT, Copyright (c) 2026 Browser Use). */

const { askJev } = require('../jev');
const { NEXT_ACTION, TARGET } = require('./questions');

const OPERATIONS = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' };
const OPERATION_LABELS = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
};

/**
 * One index per observed DOM node; each operation has its own valid targets.
 * Returns {elements, targets, controls} where controls holds scroll/wait by id.
 */
function actionSpace(actions) {
  const elements = [];
  const indices = new Map(); // node -> index string
  const targets = {};
  const controls = {};
  for (const action of actions) {
    const kind = action.kind;
    if (!Object.hasOwn(OPERATIONS, kind)) {
      controls[String(action.id).toUpperCase()] = action;
      continue;
    }
    const node = action.node;
    if (!indices.has(node)) {
      const index = String(elements.length + 1);
      indices.set(node, index);
      const element = { index, label: action.label.split(' → ')[0], operations: [] };
      for (const key of ['role', 'value', 'checked', 'selected', 'expanded']) {
        if (key in action) element[key] = action[key];
      }
      if (kind === 'select') {
        element.value = action.current_value ?? '';
        element.options = [];
      }
      elements.push(element);
    }
    const index = indices.get(node);
    const operation = OPERATIONS[kind];
    if (!Object.hasOwn(targets, operation)) targets[operation] = {};
    const group = targets[operation];
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (kind === 'select') {
      target = `${index}:${element.options.length + 1}`;
      element.options.push({ index: target, label: action.label, value: action.value });
    }
    group[target] = action;
  }
  return { elements, targets, controls };
}

/** One question's instruction text: the goal, what the question chooses, and the rules. */
function instructionsText(goal, operation, rules) {
  const head = operation
    ? `Goal: ${goal}\n\nChoose the best observed target if the next operation is ${operation}.`
    : `Goal: ${goal}`;
  return `${head}\n\n${rules.join('\n\n')}`;
}

/**
 * The one Jev request: the operation head plus a target head per available
 * operation. `instructions` is a single string: JevStation caps the structured
 * {goal, rules} form at about 600 characters, and the rules are longer than that.
 */
function buildDecisionRequest(state, goal, history, model) {
  const { elements, targets, controls } = actionSpace(state.actions);
  const operations = {};
  for (const key of Object.keys(targets)) operations[key] = OPERATION_LABELS[key];
  for (const [key, value] of Object.entries(controls)) operations[key] = value.label;
  operations.DONE = 'Every requirement is visibly satisfied.';
  operations.BLOCKED = 'No supported operation can progress.';
  const questions = {
    operation: { type: 'choice', criteria: operations, instructions: instructionsText(goal, null, [NEXT_ACTION]) },
  };
  for (const [operation, candidates] of Object.entries(targets)) {
    const indices = Object.keys(candidates);
    // JevStation rejects a choice with fewer than two criteria. With a single
    // observed candidate there is nothing to choose, so decide() takes it.
    if (indices.length < 2) continue;
    questions[`${operation.toLowerCase()}_target`] = {
      type: 'choice',
      criteria: Object.fromEntries(Object.entries(candidates).map(([index, action]) => [index, {
        element: `[${index}] ${action.label}`,
        current_value: action.current_value ?? action.value ?? '',
        ...Object.fromEntries(['role', 'checked', 'selected', 'expanded'].filter((key) => key in action).map((key) => [key, action[key]])),
      }])),
      instructions: instructionsText(goal, operation, [NEXT_ACTION, TARGET]),
    };
  }
  const body = {
    model,
    state: {
      page: { url: state.url, title: state.title, text: state.text },
      elements,
      recent_actions: history.slice(-10).map((entry) => ({
        action: entry.action ?? null,
        kind: entry.kind ?? null,
        text: entry.text ?? null,
        page_changed: entry.page_changed ?? null,
      })),
    },
    questions,
  };
  return { body, operations, targets, controls };
}

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

/**
 * A chosen id with usable confidence. `ids` is the criteria object (or a list of
 * ids). `probabilities` is optional because the JevStation envelope does not
 * guarantee it; when present it must cover exactly these ids, be finite in
 * [0, 1], sum to 1, and the choice must be its maximum.
 */
function validateChoice(answer, ids) {
  const idList = Array.isArray(ids) ? ids : Object.keys(ids ?? {});
  const probabilities = answer?.probabilities;
  const confidence = answer?.confidence;
  let valid = idList.includes(answer?.choice)
    && typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  if (valid && probabilities !== undefined) {
    const keys = Object.keys(probabilities);
    const values = Object.values(probabilities);
    valid = probabilities !== null && typeof probabilities === 'object'
      && sameSet(keys, idList)
      && values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
      && Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.02
      && probabilities[answer.choice] >= Math.max(...values) - 1e-6;
  }
  if (!valid) throw new Error('Invalid Jev response; no action executed.');
  return answer;
}

/**
 * Ask Jev for the next step and return only what executes:
 * {choice, operation, target, confidence, targetConfidence, model, credits, ms}.
 * `choice` is the observed action id ('e7', 'scroll_down', 'wait') or DONE/BLOCKED.
 */
async function decide({ state, goal, history, jev, signal, fetchImpl }) {
  const { body, operations, targets, controls } = buildDecisionRequest(state, goal, history, jev.model);
  const startedAt = Date.now();
  const { answers, model, credits } = await askJev({
    url: jev.url,
    key: jev.key,
    body,
    signal,
    timeoutMs: jev.timeoutMs,
    fetchImpl,
  });
  const operationAnswer = validateChoice(answers.operation ?? {}, operations);
  const operation = operationAnswer.choice;
  let target = null;
  let targetConfidence = null;
  let choice;
  if (Object.hasOwn(targets, operation)) {
    // Only the chosen operation's target head can execute.
    const candidates = targets[operation];
    const indices = Object.keys(candidates);
    if (indices.length === 1) {
      // No target question was sent: the sole observed candidate is the target.
      [target] = indices;
      targetConfidence = null;
    } else {
      const targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`] ?? {}, candidates);
      target = targetAnswer.choice;
      targetConfidence = Number.isFinite(targetAnswer.confidence) ? targetAnswer.confidence : null;
    }
    choice = candidates[target].id;
  } else {
    choice = Object.hasOwn(controls, operation) ? controls[operation].id : operation;
  }
  return {
    choice,
    operation,
    target,
    confidence: operationAnswer.confidence,
    targetConfidence,
    model,
    credits,
    ms: Date.now() - startedAt,
  };
}

module.exports = { actionSpace, buildDecisionRequest, decide, validateChoice };
