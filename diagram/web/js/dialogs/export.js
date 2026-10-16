import { h } from '../ui/dom.js';

const SINGLE = new Set(['png', 'svg']);

function formatsFor(sourceFormat) {
  const formats = [['png', 'PNG'], ['svg', 'SVG'], ['pdf', 'PDF']];
  if (sourceFormat === 'docx') formats.push(['docx', 'Word (.docx)']);
  else if (sourceFormat === 'pptx') formats.push(['pptx', 'PowerPoint (.pptx)']);
  else formats.push(['zip', 'Markdown (.zip)']);
  return formats;
}

// Export options. onDownload({ format, sections, transparent }) returns a promise; the dialog
// stays open (with its button disabled) until it settles, and closes on success.
export function openExport({ project, sectionId, onDownload }) {
  const ready = project.sections.filter((section) => project.diagrams?.[section.id]?.chosen);
  const formats = formatsFor(project.document.format);
  const download = h('button', { class: 'button primary', type: 'submit', disabled: ready.length === 0 }, 'Tải xuống');
  const close = h('button', { class: 'button', type: 'button' }, 'Đóng');

  const formatInputs = formats.map(([id, label], index) => {
    const input = h('input', { type: 'radio', name: 'export-format', value: id, id: `export-${id}`, checked: index === 0 });
    return { id, input, chip: h('label', { class: 'chip', for: input.id }, input, h('span', { text: label })) };
  });
  const single = h('select', { id: 'export-section' }, ready.map((section) => h('option', { value: section.id, selected: section.id === sectionId }, section.title)));
  const transparent = h('input', { type: 'checkbox', id: 'export-transparent' });
  const checks = ready.map((section) => ({ section, input: h('input', { type: 'checkbox', checked: true, id: `export-s-${section.id}` }) }));

  const singleField = h('div', { class: 'field' }, h('label', { for: 'export-section', text: 'Phần' }), single);
  const transparentField = h('div', { class: 'field check' }, transparent, h('label', { for: 'export-transparent', text: 'Nền trong suốt' }));
  const multiField = h('fieldset', { class: 'field section-checks' }, h('legend', { text: 'Các phần' }),
    checks.map(({ section, input }) => h('div', { class: 'check' }, input, h('label', { for: input.id, text: section.title }))));

  const body = ready.length === 0
    ? [h('p', { class: 'lead', text: 'Chọn một phương án cho ít nhất một phần trước khi xuất.' })]
    : [h('fieldset', { class: 'field' }, h('legend', { text: 'Định dạng' }), h('div', { class: 'chips' }, formatInputs.map((entry) => entry.chip))), singleField, transparentField, multiField];
  const form = h('form', { method: 'dialog' }, h('h2', { text: 'Xuất sơ đồ' }), body, h('div', { class: 'dialog-actions' }, close, download));
  const dialog = h('dialog', { class: 'export-dialog', 'aria-label': 'Xuất sơ đồ' }, form);
  document.body.append(dialog);

  const format = () => formatInputs.find((entry) => entry.input.checked)?.id ?? 'png';
  const sections = () => (SINGLE.has(format()) ? [single.value] : checks.filter((entry) => entry.input.checked).map((entry) => entry.section.id));
  const refresh = () => {
    const isSingle = SINGLE.has(format());
    singleField.hidden = !isSingle;
    transparentField.hidden = format() !== 'png';
    multiField.hidden = isSingle;
    download.disabled = ready.length === 0 || sections().length === 0;
  };
  form.addEventListener('change', refresh);
  if (ready.length > 0) refresh();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (download.disabled) return;
    download.disabled = true;
    try {
      await onDownload({ format: format(), sections: sections(), transparent: format() === 'png' && transparent.checked });
      dialog.close();
    } catch {
      refresh();
    }
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  return dialog;
}
