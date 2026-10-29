import { createHistory, pushHistory } from '../../shared/spec/history.js';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get() {
      return state;
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function selectSection(state, sectionId) {
  const histories = { ...(state.histories ?? {}) };
  if (!histories[sectionId]) {
    const chosen = state.project?.diagrams?.[sectionId]?.chosen;
    if (chosen) histories[sectionId] = createHistory(chosen);
  }
  return { ...state, sectionId, selectedNodeId: null, histories };
}

export function currentSpec(state) {
  const history = state.histories?.[state.sectionId];
  return history ? history.present : null;
}

export function applyEdit(state, specOrFn) {
  const sectionId = state.sectionId;
  const history = state.histories?.[sectionId];
  if (!history) return state;
  const next = typeof specOrFn === 'function' ? specOrFn(history.present) : specOrFn;
  return { ...state, histories: { ...state.histories, [sectionId]: pushHistory(history, next) } };
}
