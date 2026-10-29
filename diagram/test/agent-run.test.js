import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgent } from '../server/agent/index.js';
import { createFakeAdapter } from '../server/agent/fake.js';
import { ingestText, ingestFile } from '../server/ingest/index.js';
import { loadConfig } from '../server/config.js';
import { buildPptx } from './helpers/office.js';

const config = { ...loadConfig({ DIAGRAM_AGENT: 'fake' }), agentTimeoutMs: 2000 };
const signal = () => new AbortController().signal;

test('fake segment asks first, then answers with sections', async () => {
  const agent = createAgent(config);
  const document = ingestText('# Quy trình [[hỏi]]\n\nNghiên cứu.\n\nThiết kế.\n\n# Khác\n\nMột ý.');
  const first = await agent.run('segment', { document, answers: [] }, { signal: signal() });
  assert.equal(first.questions.length, 1);
  assert.deepEqual(first.sections, []);
  const answers = [{ questionId: 'q1', question: first.questions[0].text, optionIds: ['b'], optionLabels: ['Các ý độc lập'], free: '' }];
  const second = await agent.run('segment', { document, answers }, { signal: signal() });
  assert.equal(second.sections.length, 2);
});

test('a pptx deck becomes one section per slide', async () => {
  const buffer = await buildPptx([
    { title: 'Tổng quan', lines: ['Giới thiệu sản phẩm.'] },
    { title: 'Kế hoạch', lines: ['Ba giai đoạn chính.'] },
    { title: 'Ngân sách', lines: ['Chi phí dự kiến.'] },
  ]);
  const document = await ingestFile({ filename: 'deck.pptx', buffer });
  const out = await createFakeAdapter().run({ task: 'segment', user: JSON.stringify({ document, answers: [] }), signal: signal() });
  assert.equal(out.sections.length, 3);
  assert.deepEqual(out.sections.map((section) => section.title), ['Tổng quan', 'Kế hoạch', 'Ngân sách']);
});

test('fake generate returns three valid candidates', async () => {
  const document = ingestText('Nghiên cứu khách hàng.\nThiết kế giải pháp.\nPhát triển sản phẩm.\nRa mắt.');
  const section = { id: 's1', blockIds: ['b0'], title: 'Quy trình', summary: '', suggestedKinds: [] };
  const out = await createAgent(config).run('generate', { document, section, answers: [] }, { signal: signal() });
  assert.deepEqual(out.candidates.map((c) => c.template), ['steps', 'cards', 'timeline']);
});

test('fake generate follows an "independent ideas" answer', async () => {
  const document = ingestText('Nghiên cứu khách hàng.\nThiết kế giải pháp.\nPhát triển sản phẩm.');
  const section = { id: 's1', blockIds: ['b0'], title: 'Ý chính', summary: '', suggestedKinds: [] };
  const answers = [{ questionId: 'q1', question: 'Thứ tự?', optionIds: ['b'], optionLabels: ['Các ý độc lập'], free: '' }];
  const out = await createAgent(config).run('generate', { document, section, answers }, { signal: signal() });
  assert.deepEqual(out.candidates.map((c) => c.template), ['cards', 'icon-row', 'steps']);
});

test('a bad answer is retried once, then reported as agent_bad_output', async () => {
  let calls = 0;
  const adapter = { name: 'bad', run: async () => { calls += 1; return { nonsense: true }; } };
  const document = ingestText('Một.\n\nHai.\n\nBa.\n\nBốn.\n\nNăm.');
  await assert.rejects(createAgent(config, { adapter }).run('segment', { document, answers: [] }, { signal: signal() }), { code: 'agent_bad_output' });
  assert.equal(calls, 2);
});

test('the second attempt is told why the first was rejected', async () => {
  const users = [];
  const good = { questions: [], sections: [{ blockIds: ['b0'], title: 'A', summary: '', suggestedKinds: ['list'] }] };
  const adapter = { name: 'flaky', run: async ({ user }) => { users.push(user); return users.length === 1 ? { questions: [], sections: [] } : good; } };
  const document = ingestText('Một.\n\nHai.\n\nBa.\n\nBốn.\n\nNăm.');
  const out = await createAgent(config, { adapter }).run('segment', { document, answers: [] }, { signal: signal() });
  assert.equal(out.sections.length, 1);
  assert.ok(users[1].includes('Your previous answer was rejected'));
});

test('a slow agent times out', async () => {
  const agent = createAgent({ ...config, agentTimeoutMs: 50 }, { adapter: createFakeAdapter({ delayMs: 1000 }) });
  const document = ingestText('Một.\n\nHai.\n\nBa.\n\nBốn.\n\nNăm.');
  await assert.rejects(agent.run('segment', { document, answers: [] }, { signal: signal() }), { code: 'agent_timeout' });
});
