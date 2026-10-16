import { HISTORY_LIMIT } from './constants.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createHistory(spec) {
  return { past: [], present: spec, future: [] };
}

export function pushHistory(history, spec) {
  if (same(history.present, spec)) return history;
  const past = [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: spec, future: [] };
}

export function canUndo(history) {
  return history.past.length > 0;
}

export function canRedo(history) {
  return history.future.length > 0;
}

export function replaceHistory(history, spec) {
  return { past: history.past, present: spec, future: history.future };
}

export function undo(history) {
  if (!canUndo(history)) return history;
  const present = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  };
}

export function redo(history) {
  if (!canRedo(history)) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}
