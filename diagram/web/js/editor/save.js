// Debounced saver: only the latest spec per section is sent, saves run one batch at a time so
// they reach the server in order, and flush sends the pending ones at once (called before
// refine, export and route changes). A failed save goes to onError; flush never rejects.
export function createSaver({ save, delayMs = 800, onError = () => {} }) {
  const pending = new Map();
  let timer = null;
  let chain = Promise.resolve();

  function flush() {
    clearTimeout(timer);
    timer = null;
    const entries = [...pending.entries()];
    pending.clear();
    if (entries.length > 0) {
      chain = chain.then(() => Promise.all(entries.map(([sectionId, spec]) => save(sectionId, spec).catch(onError))));
    }
    return chain;
  }

  function schedule(sectionId, spec) {
    pending.set(sectionId, spec);
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }

  return { schedule, flush };
}
