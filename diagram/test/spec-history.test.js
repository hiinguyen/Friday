import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, pushHistory, undo, redo, canUndo, canRedo } from '../shared/spec/history.js';
import { makeSpec } from './helpers/specs.js';

test('undo and redo walk the history', () => {
  let h = createHistory(makeSpec({ title: 'a' }));
  h = pushHistory(h, makeSpec({ title: 'b' }));
  h = pushHistory(h, makeSpec({ title: 'c' }));
  h = undo(h);
  assert.equal(h.present.title, 'b');
  assert.ok(canRedo(h));
  h = redo(h);
  assert.equal(h.present.title, 'c');
  assert.ok(!canRedo(h));
});

test('a new edit after undo drops the redo branch', () => {
  let h = pushHistory(createHistory(makeSpec({ title: 'a' })), makeSpec({ title: 'b' }));
  h = pushHistory(undo(h), makeSpec({ title: 'x' }));
  assert.ok(!canRedo(h));
  assert.equal(undo(h).present.title, 'a');
});

test('history is capped at 100 steps and ignores identical pushes', () => {
  let h = createHistory(makeSpec({ title: '0' }));
  for (let i = 1; i <= 150; i += 1) h = pushHistory(h, makeSpec({ title: String(i) }));
  assert.equal(h.past.length, 100);
  assert.equal(pushHistory(h, makeSpec({ title: '150' })), h);
  assert.ok(canUndo(h));
});
