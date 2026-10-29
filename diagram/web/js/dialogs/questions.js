import { h } from '../ui/dom.js';

let questionSeq = 0;

// Modal for the agent's clarifying questions. Submitting resolves with Answer[]; "Bỏ qua" or
// Escape leaves the questions pending and calls onSkip.
export function openQuestions({ questions, onSubmit, onSkip }) {
  const fields = questions.map((question) => {
    const name = `q-${(questionSeq += 1)}`;
    const inputs = question.options.map((option) => {
      const input = h('input', { type: question.multi ? 'checkbox' : 'radio', name, value: option.id, id: `${name}-${option.id}` });
      return { option, input, chip: h('label', { class: 'chip', for: input.id }, input, h('span', { text: option.label })) };
    });
    const free = question.allowFree ? h('input', { type: 'text', class: 'free', maxlength: '200', placeholder: 'Ý khác...', 'aria-label': `Ý khác cho: ${question.text}` }) : null;
    const fieldset = h('fieldset', { class: 'question' }, h('legend', { text: question.text }), h('div', { class: 'chips' }, inputs.map((entry) => entry.chip)), free);
    return { question, inputs, free, fieldset };
  });

  const submit = h('button', { class: 'button primary', type: 'submit', disabled: true }, 'Gửi câu trả lời');
  const skip = h('button', { class: 'button', type: 'button' }, 'Bỏ qua');
  const form = h('form', { method: 'dialog' },
    h('h2', { text: 'AI cần bạn làm rõ' }),
    h('p', { class: 'lead', text: 'Trả lời để AI vẽ sơ đồ đúng ý hơn.' }),
    fields.map((field) => field.fieldset),
    h('div', { class: 'dialog-actions' }, skip, submit));
  const dialog = h('dialog', { class: 'questions-dialog', 'aria-label': 'AI cần bạn làm rõ' }, form);
  document.body.append(dialog);

  const answers = () => fields.map(({ question, inputs, free }) => {
    const chosen = inputs.filter((entry) => entry.input.checked).map((entry) => entry.option);
    return { questionId: question.id, question: question.text, optionIds: chosen.map((o) => o.id), optionLabels: chosen.map((o) => o.label), free: free ? free.value.trim() : '' };
  });
  const refresh = () => { submit.disabled = !answers().every((answer) => answer.optionIds.length > 0 || answer.free !== ''); };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);

  let submitted = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submitted = true;
    const result = answers();
    dialog.close();
    onSubmit(result);
  });
  skip.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (!submitted) onSkip?.();
  });
  dialog.showModal();
  fields[0]?.inputs[0]?.input.focus();
  return dialog;
}
