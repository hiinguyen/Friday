import { getTemplate, TEMPLATE_IDS, TEMPLATE_KINDS } from '../../shared/render/registry.js';
import { normalizeSpec } from '../../shared/spec/normalize.js';
import { validateSpec } from '../../shared/spec/validate.js';
import { applyLocks } from '../../shared/spec/locks.js';
import { ICON_NAMES } from '../../shared/icons/icons.js';
import { catalogue, iconLine } from './prompt-catalog.js';
import { BadOutput, extractJson } from './json-extract.js';

export { BadOutput, extractJson };

const TEXT_BUDGET = 60000;

const QUESTION = {
  type: 'object', additionalProperties: false,
  required: ['id', 'text', 'multi', 'allowFree', 'options'],
  properties: {
    id: { type: 'string' },
    text: { type: 'string', maxLength: 200 },
    multi: { type: 'boolean' },
    allowFree: { type: 'boolean' },
    options: {
      type: 'array', minItems: 2, maxItems: 5, items: {
        type: 'object', additionalProperties: false, required: ['id', 'label'],
        properties: { id: { type: 'string' }, label: { type: 'string', maxLength: 80 } },
      },
    },
  },
};

const AGENT_NODE = {
  type: 'object', additionalProperties: false,
  required: ['id', 'label', 'detail', 'icon', 'parent', 'value', 'emphasis'],
  properties: {
    id: { type: 'string' }, label: { type: 'string' }, detail: { type: 'string' }, icon: { type: 'string' },
    parent: { type: ['string', 'null'] }, value: { type: ['number', 'null'] }, emphasis: { type: 'boolean' },
  },
};

const AGENT_DIAGRAM = {
  type: 'object', additionalProperties: false,
  required: ['template', 'title', 'subtitle', 'nodes', 'edges'],
  properties: {
    template: { type: 'string', enum: TEMPLATE_IDS },
    title: { type: 'string' }, subtitle: { type: 'string' },
    nodes: { type: 'array', minItems: 1, maxItems: 16, items: AGENT_NODE },
    edges: {
      type: 'array', maxItems: 30, items: {
        type: 'object', additionalProperties: false, required: ['from', 'to', 'label'],
        properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
      },
    },
  },
};

export const SEGMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions', 'sections'],
  properties: {
    questions: { type: 'array', maxItems: 3, items: QUESTION },
    sections: {
      type: 'array', maxItems: 20, items: {
        type: 'object', additionalProperties: false, required: ['blockIds', 'title', 'summary', 'suggestedKinds'],
        properties: {
          blockIds: { type: 'array', minItems: 1, items: { type: 'string' } },
          title: { type: 'string', maxLength: 80 }, summary: { type: 'string', maxLength: 300 },
          suggestedKinds: { type: 'array', maxItems: 3, items: { type: 'string', enum: TEMPLATE_KINDS } },
        },
      },
    },
  },
};

export const GENERATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['questions', 'candidates'],
  properties: { questions: { type: 'array', maxItems: 3, items: QUESTION }, candidates: { type: 'array', maxItems: 3, items: AGENT_DIAGRAM } },
};

export const REFINE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['diagram'],
  properties: { diagram: AGENT_DIAGRAM },
};

const SYSTEM_INTRO = `You turn text into diagrams for a visual editor. Answer with exactly one JSON object that matches the JSON Schema you were given. Never call tools, never browse, never write anything outside the JSON.

Language: write every title, label, detail, question and option in the language of the source text. Vietnamese text gives Vietnamese diagrams and Vietnamese questions.

Faithfulness: use only facts from the source text and the user's answers. Never invent numbers, names, dates or steps. Shorten; do not embellish.

Diagram writing: labels are 1-6 words (at most 60 characters) without a trailing full stop; a detail is one short phrase or sentence (at most 160 characters) or an empty string; titles are at most 80 characters. Node ids are short and unique (n1, n2, ...). parent is the id of the parent node or null. value is a number taken from the text, or null. Set emphasis to true on at most two key nodes. icon is the closest name from the icon list below.`;

const TASK_TEXT = {
  segment: `Task: split the document into sections that are each worth one diagram. A section is a run of consecutive blocks (by id) about one structure: a process, a list, a comparison, a hierarchy, a timeline. Skip blocks with nothing to visualise. Give a short document 1 section; give a long one at most 1 section per 2-4 paragraphs (20 at most). For each section give a short title, a one-sentence summary and 1-3 suggestedKinds. Instead of sections, return questions (and an empty sections list) only when the document is too vague to know what to draw: it is a single sentence without structure, it is unclear whether items are ordered steps or independent points, or it mixes topics and the focus is unclear. Ask at most 3 questions, each with 2-5 concrete options that are possible readings of the text. Never ask about something already answered in "answers".`,
  generate: `Task: propose 3 different diagrams for the section. Use 3 different templates, the best fit first. Each candidate respects its template's node range; fill edges only for flowchart and parent only for templates that use it. Instead of candidates, return questions (and an empty candidates list) only when the section is ambiguous in a way that changes the diagram, for example the order of the steps is unknown or the main groups are unclear. Same question rules: at most 3, 2-5 concrete options each, never repeat an answered question.`,
  refine: `Task: improve the user's edited diagram and return the whole diagram. Keep its template and the ids of existing nodes. Paths listed in "locks" were written by the user: copy those fields exactly (title, subtitle, <nodeId>.label, <nodeId>.detail, <nodeId>.icon, <nodeId>.color) and keep the node order when "nodes.order" is locked. Follow the user's instruction when there is one. Otherwise make the diagram consistent: parallel wording, details only where the source supports them, fitting icons, everything within the limits.`,
};

function systemPrompt(task) {
  return `${SYSTEM_INTRO}\n\nTemplates:\n${catalogue()}\n\n${iconLine()}\n\n${TASK_TEXT[task]}`;
}

function answersPayload(answers) {
  return (answers ?? []).map((answer) => ({
    question: answer.question ?? '',
    chosen: answer.optionLabels ?? [],
    free: answer.free ?? '',
  }));
}

function sectionPayload(context) {
  const blocks = context.document?.blocks ?? [];
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const text = (context.section?.blockIds ?? []).map((id) => byId.get(id)?.text).filter((value) => Boolean(value)).join('\n\n');
  return { id: context.section?.id ?? '', title: context.section?.title ?? '', summary: context.section?.summary ?? '', text };
}

function trimToBudget(payload) {
  let json = JSON.stringify(payload, null, 2);
  if (json.length <= TEXT_BUDGET) return json;
  if (payload.document) {
    while (json.length > TEXT_BUDGET && payload.document.blocks.length > 0) {
      payload.document.blocks.pop();
      payload.document.truncated = true;
      json = JSON.stringify(payload, null, 2);
    }
  } else if (payload.section) {
    let text = payload.section.text;
    while (json.length > TEXT_BUDGET && text.length > 0) {
      text = text.slice(0, Math.floor(text.length * 0.9));
      payload.section.text = text;
      payload.section.truncated = true;
      json = JSON.stringify(payload, null, 2);
    }
  }
  return json;
}

function segmentUser(context) {
  return trimToBudget({
    document: {
      title: context.document.title,
      format: context.document.format,
      blocks: context.document.blocks.map((block) => ({ id: block.id, kind: block.kind, text: block.text })),
      truncated: false,
    },
    answers: answersPayload(context.answers),
  });
}

function diagramUser(context) {
  const payload = {
    section: sectionPayload(context),
    answers: answersPayload(context.answers),
  };
  if (context.diagram) {
    payload.diagram = {
      template: context.diagram.template,
      title: context.diagram.title,
      subtitle: context.diagram.subtitle,
      nodes: context.diagram.nodes,
      edges: context.diagram.edges,
      locks: context.diagram.locks ?? [],
    };
    payload.instruction = context.instruction ?? '';
  }
  return trimToBudget(payload);
}

function optionId(index) {
  return String.fromCharCode(97 + index);
}

function normalizeQuestions(questions) {
  return (questions ?? []).map((question, index) => ({
    id: `q${index + 1}`,
    text: String(question.text ?? '').trim(),
    multi: question.multi === true,
    allowFree: question.allowFree !== false,
    options: (question.options ?? []).map((option, optionIndex) => ({ id: optionId(optionIndex), label: String(option.label ?? '').trim() })),
  }));
}

function postprocessSegment(raw, context) {
  const questions = normalizeQuestions(raw.questions);
  const blocks = context.document?.blocks ?? [];
  const order = new Map(blocks.map((block, index) => [block.id, index]));
  const valid = new Set(blocks.map((block) => block.id));
  const sections = [];
  for (const section of raw.sections ?? []) {
    const blockIds = [...new Set((section.blockIds ?? []).filter((id) => valid.has(id)))].sort((a, b) => order.get(a) - order.get(b));
    if (blockIds.length === 0) continue;
    const kinds = Array.isArray(section.suggestedKinds) && section.suggestedKinds.length > 0 ? section.suggestedKinds : ['list'];
    sections.push({ id: `s${sections.length + 1}`, blockIds, title: String(section.title ?? '').trim(), summary: String(section.summary ?? '').trim(), suggestedKinds: kinds });
  }
  if (questions.length === 0 && sections.length === 0) throw new BadOutput('no sections and no questions');
  return { questions, sections };
}

function postprocessGenerate(raw, context) {
  const questions = normalizeQuestions(raw.questions);
  const candidates = [];
  const seen = new Set();
  for (const candidate of raw.candidates ?? []) {
    const template = getTemplate(candidate.template);
    const { spec } = normalizeSpec(candidate, { template, iconNames: ICON_NAMES, sectionId: context.section?.id });
    if (validateSpec(spec).length > 0) continue;
    if (seen.has(spec.template)) continue;
    seen.add(spec.template);
    candidates.push(spec);
    if (candidates.length >= 3) break;
  }
  if (candidates.length === 0 && questions.length === 0) throw new BadOutput('no valid candidate');
  return { questions, candidates };
}

function postprocessRefine(raw, context) {
  const edited = context.diagram;
  const template = getTemplate(edited.template);
  const { spec } = normalizeSpec(raw.diagram, { template, iconNames: ICON_NAMES, sectionId: edited.sectionId });
  const applied = applyLocks(edited, spec);
  const result = { ...applied, id: edited.id, sectionId: edited.sectionId, style: edited.style, lang: edited.lang };
  if (validateSpec(result).length > 0) throw new BadOutput('refined diagram is invalid');
  return { spec: result };
}

export const TASKS = {
  segment: { schema: SEGMENT_SCHEMA, system: () => systemPrompt('segment'), user: segmentUser, postprocess: postprocessSegment },
  generate: { schema: GENERATE_SCHEMA, system: () => systemPrompt('generate'), user: diagramUser, postprocess: postprocessGenerate },
  refine: { schema: REFINE_SCHEMA, system: () => systemPrompt('refine'), user: diagramUser, postprocess: postprocessRefine },
};

export function shouldSkipSegment(document) {
  const blocks = document?.blocks ?? [];
  if (blocks.length > 4) return false;
  const characters = blocks.reduce((total, block) => total + block.text.length, 0);
  return characters <= 1500;
}

export function singleSection(document) {
  return { id: 's1', blockIds: document.blocks.map((block) => block.id), title: document.title, summary: '', suggestedKinds: [] };
}
