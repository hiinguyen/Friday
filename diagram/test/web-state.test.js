import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, applyEdit, currentSpec } from '../web/js/state.js';
import { createHistory } from '../shared/spec/history.js';
import { makeSpec } from './helpers/specs.js';

test('the store notifies subscribers after each set', () => {
  const store = createStore({ a: 1 });
  const seen = [];
  const off = store.subscribe((s) => seen.push(s.a));
  store.set({ a: 2 });
  off();
  store.set({ a: 3 });
  assert.deepEqual(seen, [2]);
  assert.equal(store.get().a, 3);
});

test('applyEdit pushes onto the open section history without mutating', () => {
  const state = { sectionId: 's1', histories: { s1: createHistory(makeSpec({ title: 'a' })) } };
  const next = applyEdit(state, (spec) => ({ ...spec, title: 'b' }));
  assert.equal(currentSpec(next).title, 'b');
  assert.equal(currentSpec(state).title, 'a');
  assert.equal(next.histories.s1.past.length, 1);
});
