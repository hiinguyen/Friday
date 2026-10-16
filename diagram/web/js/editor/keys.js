// Editor shortcuts. Undo, redo and Escape (clear the selection) work anywhere outside a text
// field; Delete, Enter and the arrows only when focus is on the page body or the canvas, so a
// focused button keeps its own Enter and arrow keys. Each action returns true when it acted.
const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"]';

function inEditorScope(target) {
  return target === document.body || target === document.documentElement || Boolean(target.closest?.('[data-editor-scope]'));
}

export function installKeys(actions) {
  function onKeyDown(event) {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : document.body;
    if (target.closest(TEXT_FIELD) || document.querySelector('dialog[open]')) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    let handled = false;
    if (mod && key === 'z') handled = event.shiftKey ? actions.redo() : actions.undo();
    else if (mod && key === 'y') handled = actions.redo();
    else if (event.key === 'Escape') handled = actions.select(null);
    else if (!mod && !event.altKey && inEditorScope(target)) {
      if (event.key === 'Delete' || event.key === 'Backspace') handled = actions.removeSelected();
      else if (event.key === 'Enter') handled = actions.editSelected();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') handled = actions.selectStep(1);
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') handled = actions.selectStep(-1);
    }
    if (handled) event.preventDefault();
  }
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}
