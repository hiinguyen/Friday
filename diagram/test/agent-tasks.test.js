import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, extractJson, shouldSkipSegment, singleSection } from '../server/agent/tasks.js';
import { ingestText } from '../server/ingest/index.js';
import { makeSpec } from './helpers/specs.js';

const doc = ingestText('# Một\n\nĐoạn A.\n\n# Hai\n\nĐoạn B.\n\nĐoạn C.\n\nĐoạn D.');

test('the system prompt lists every template and the icon names', () => {
  const system = TASKS.generate.system();
  for (const id of ['cards', 'timeline', 'venn', 'flowchart']) assert.ok(system.includes(`- ${id} (`), id);
  assert.ok(system.includes('rocket'));
});

test('the user payload carries blocks, answers and stays under the budget', () => {
  const big = ingestText(Array.from({ length: 400 }, (_, i) => `Đoạn văn số ${i} `.repeat(30)).join('\n\n'));
  const user = TASKS.segment.user({ document: big, answers: [] });
  assert.ok(user.length <= 60000);
  assert.equal(JSON.parse(user).document.truncated, true);
});

test('segment post-processing cleans block ids and numbers sections', () => {
  const out = TASKS.segment.postprocess({ questions: [], sections: [
    { blockIds: ['b3', 'b2', 'b2', 'zz'], title: 'Hai', summary: '', suggestedKinds: [] },
    { blockIds: ['zz'], title: 'rỗng', summary: '', suggestedKinds: ['list'] },
  ] }, { document: doc });
  assert.deepEqual(out.sections, [{ id: 's1', blockIds: ['b2', 'b3'], title: 'Hai', summary: '', suggestedKinds: ['list'] }]);
});

test('generate keeps valid candidates with distinct templates', () => {
  const node = (id, label) => ({ id, label, detail: '', icon: 'rocket', parent: null, value: null, emphasis: false });
  const candidate = (template) => ({ template, title: 'T', subtitle: '', nodes: [node('n1', 'A'), node('n2', 'B'), node('n3', 'C')], edges: [] });
  const out = TASKS.generate.postprocess({ questions: [], candidates: [candidate('steps'), candidate('steps'), candidate('cards')] }, { section: { id: 's1' } });
  assert.deepEqual(out.candidates.map((c) => c.template), ['steps', 'cards']);
  assert.equal(out.candidates[0].sectionId, 's1');
});

test('refine restores locked fields and keeps the edited template and style', () => {
  const edited = makeSpec({ title: 'Của tôi', locks: ['title'], style: { theme: 'ocean', density: 'airy' } });
  const raw = { diagram: { template: 'venn', title: 'AI', subtitle: '', nodes: edited.nodes.map((n) => ({ ...n, label: 'AI' })), edges: [] } };
  const { spec } = TASKS.refine.postprocess(raw, { diagram: edited });
  assert.equal(spec.title, 'Của tôi');
  assert.equal(spec.template, 'cards');
  assert.deepEqual(spec.style, { theme: 'ocean', density: 'airy' });
  assert.equal(spec.nodes[0].label, 'AI');
});

test('extractJson finds the object inside prose and fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Đây: {"a":"}{","b":{"c":2}} xong'), { a: '}{', b: { c: 2 } });
  assert.throws(() => extractJson('không có json'), /no JSON/);
});

test('short documents skip segmentation', () => {
  assert.equal(shouldSkipSegment(ingestText('Một đoạn ngắn.')), true);
  assert.equal(singleSection(ingestText('Một đoạn ngắn.')).blockIds.length, 1);
});
