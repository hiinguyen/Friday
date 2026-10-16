import { AppError } from '../errors.js';

export const QUESTION_STEPS = {
  id: 'q1',
  text: 'Các mục này là các bước theo thứ tự hay các ý độc lập?',
  multi: false,
  allowFree: true,
  options: [
    { id: 'a', label: 'Các bước theo thứ tự' },
    { id: 'b', label: 'Các ý độc lập' },
  ],
};

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new AppError('cancelled'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      cleanup();
      reject(new AppError('cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort);
  });
}

function hasBlankAnswer(payload) {
  return (payload.answers ?? []).length === 0;
}

function fakeSegment(payload) {
  const blocks = payload.document?.blocks ?? [];
  if (hasBlankAnswer(payload) && blocks.some((block) => block.text.includes('[[hỏi]]'))) {
    return { questions: [QUESTION_STEPS], sections: [] };
  }
  const groups = [];
  for (const block of blocks) {
    if (groups.length === 0 || block.kind === 'heading' || block.kind === 'slide') groups.push([]);
    groups[groups.length - 1].push(block);
  }
  const sections = groups
    .filter((group) => !(group.length === 1 && group[0].kind === 'heading'))
    .map((group) => {
      const first = group[0];
      return {
        blockIds: group.map((block) => block.id),
        title: (first.kind === 'slide' ? first.text.split('\n')[0] : first.text).slice(0, 40),
        summary: '',
        suggestedKinds: ['list'],
      };
    });
  return { questions: [], sections };
}

function nodesFromText(text) {
  const pieces = [];
  for (const line of text.split('\n')) {
    for (const part of line.split('. ')) {
      const cleaned = part.replace(/^\s*([-*\u2022]|\d+[.)])\s+/, '').replace(/\.\s*$/, '').trim();
      if (cleaned !== '') pieces.push(cleaned);
    }
  }
  return pieces.slice(0, 6).map((piece, index) => {
    const words = piece.split(/\s+/);
    return {
      id: `n${index + 1}`,
      label: words.slice(0, 6).join(' ').slice(0, 60),
      detail: words.slice(6).join(' ').slice(0, 160),
      icon: 'circle',
      parent: null,
      value: null,
      emphasis: index === 0,
    };
  });
}

function fakeGenerate(payload) {
  const sectionText = payload.section?.text ?? '';
  if (hasBlankAnswer(payload) && sectionText.includes('[[hỏi]]')) {
    return { questions: [QUESTION_STEPS], candidates: [] };
  }
  const nodes = nodesFromText(sectionText);
  const independent = (payload.answers ?? []).some((answer) => (answer.chosen ?? []).some((label) => String(label).includes('độc lập')));
  const templates = independent ? ['cards', 'icon-row', 'steps'] : ['steps', 'cards', 'timeline'];
  return {
    questions: [],
    candidates: templates.map((template) => ({ template, title: payload.section?.title ?? '', subtitle: '', nodes, edges: [] })),
  };
}

function fakeRefine(payload) {
  const diagram = payload.diagram ?? {};
  return {
    diagram: {
      template: diagram.template,
      title: diagram.title ?? '',
      subtitle: diagram.subtitle ?? '',
      nodes: (diagram.nodes ?? []).map((node) => ({
        id: node.id,
        label: `AI: ${node.label}`.slice(0, 60),
        detail: node.detail ? node.detail : 'Đã bổ sung',
        icon: node.icon,
        parent: node.parent ?? null,
        value: typeof node.value === 'number' ? node.value : null,
        emphasis: node.emphasis === true,
      })),
      edges: diagram.edges ?? [],
    },
  };
}

export function createFakeAdapter({ delayMs = 0 } = {}) {
  return {
    name: 'fake',
    async run({ task, user, signal }) {
      if (delayMs > 0) await wait(delayMs, signal);
      const payload = JSON.parse(user);
      if (task === 'segment') return fakeSegment(payload);
      if (task === 'generate') return fakeGenerate(payload);
      return fakeRefine(payload);
    },
  };
}
