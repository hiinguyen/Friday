import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, json } from './helpers/app.js';
import { buildDocx } from './helpers/office.js';
import { AppError } from '../server/errors.js';

const LONG = '# Quy trình\n\nNghiên cứu khách hàng.\n\nThiết kế giải pháp.\n\nPhát triển sản phẩm.\n\n# Đo lường\n\nTheo dõi số liệu sau khi ra mắt.';

async function createText(app, text) {
  return json(await app.inject({ method: 'POST', url: '/api/projects', payload: { text } })).data;
}

test('health is public and reports whether a token is needed', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_TOKEN: 'secret-123' } });
  const health = json(await t.app.inject({ url: '/api/health' }));
  assert.deepEqual(health, { ok: true, data: { agent: 'fake', needsToken: true } });
  const denied = await t.app.inject({ url: '/api/projects' });
  assert.equal(denied.statusCode, 401);
  assert.equal(json(denied).error.code, 'unauthorized');
  const wrong = await t.app.inject({ url: '/api/projects', headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.statusCode, 401);
  const allowed = await t.app.inject({ url: '/api/projects', headers: { authorization: 'Bearer secret-123' } });
  assert.equal(allowed.statusCode, 200);
  await t.close();
});

test('text project: segment, generate, save an edit, refine with locks', async () => {
  const t = await makeTestApp();
  const project = await createText(t.app, LONG);
  assert.equal(project.document.blocks.length, 6);
  const segmented = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} })).data;
  assert.equal(segmented.sections.length, 2);
  const sid = segmented.sections[0].id;
  const generated = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/sections/${sid}/generate`, payload: {} })).data;
  const candidates = generated.diagrams[sid].candidates;
  assert.equal(candidates.length, 3);
  const edited = { ...candidates[0], title: 'Của tôi', locks: ['title', 'n1.label'], nodes: candidates[0].nodes.map((n, i) => (i === 0 ? { ...n, label: 'Tự sửa' } : n)) };
  const saved = json(await t.app.inject({ method: 'PUT', url: `/api/projects/${project.id}/sections/${sid}/diagram`, payload: { spec: edited } })).data;
  assert.equal(saved.diagrams[sid].chosen.title, 'Của tôi');
  const refined = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/sections/${sid}/refine`, payload: { spec: edited, instruction: '' } })).data;
  const chosen = refined.diagrams[sid].chosen;
  assert.equal(chosen.title, 'Của tôi');
  assert.equal(chosen.nodes[0].label, 'Tự sửa');
  assert.ok(chosen.nodes[1].label.startsWith('AI: '));
  await t.close();
});

test('questions are stored, then answered', async () => {
  const t = await makeTestApp();
  const project = await createText(t.app, `${LONG}\n\nGhi chú [[hỏi]]`);
  const asked = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} })).data;
  assert.equal(asked.pendingQuestions.task, 'segment');
  const q = asked.pendingQuestions.questions[0];
  const answers = [{ questionId: q.id, question: q.text, optionIds: ['a'], optionLabels: [q.options[0].label], free: '' }];
  const answered = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: { answers } })).data;
  assert.equal(answered.pendingQuestions, null);
  assert.equal(answered.answers.length, 1);
  assert.ok(answered.sections.length > 0);
  await t.close();
});

test('short text skips the segment call', async () => {
  let calls = 0;
  const agent = { name: 'spy', run: async () => { calls += 1; throw new Error('should not be called'); } };
  const t = await makeTestApp({ agent });
  const project = await createText(t.app, 'Một đoạn ngắn về quy trình.');
  const out = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} })).data;
  assert.equal(out.sections.length, 1);
  assert.equal(calls, 0);
  await t.close();
});

test('a second agent call on the same project is refused while one runs, and can be cancelled', async () => {
  let release;
  const agent = { name: 'slow', run: (task, context, { signal }) => new Promise((resolve, reject) => {
    release = resolve;
    signal.addEventListener('abort', () => reject(new AppError('cancelled')));
  }) };
  const t = await makeTestApp({ agent });
  const project = await createText(t.app, LONG);
  const first = t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} });
  await new Promise((r) => setTimeout(r, 20));
  const second = await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} });
  assert.equal(second.statusCode, 409);
  assert.equal(json(second).error.code, 'busy');
  const cancel = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/cancel` })).data;
  assert.equal(cancel.cancelled, true);
  assert.equal((await first).statusCode, 409);
  assert.ok(release);
  await t.close();
});

test('docx upload keeps the source and rejects other types', async () => {
  const t = await makeTestApp();
  const buffer = await buildDocx([{ text: 'Tiêu đề', heading: 1 }, 'Đoạn một.']);
  const boundary = '----diagramtest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).data.sourceFile, 'source.docx');
  const bad = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: '' } });
  assert.equal(bad.statusCode, 400);
  await t.close();
});

test('invalid specs are refused and unknown sections are 404', async () => {
  const t = await makeTestApp();
  const project = await createText(t.app, LONG);
  const segmented = json(await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} })).data;
  const sid = segmented.sections[0].id;
  const bad = await t.app.inject({ method: 'PUT', url: `/api/projects/${project.id}/sections/${sid}/diagram`, payload: { spec: { version: 9 } } });
  assert.equal(bad.statusCode, 400);
  const missing = await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/sections/zz/generate`, payload: {} });
  assert.equal(missing.statusCode, 404);
  await t.close();
});

test('static files and vendor modules are served', async () => {
  const t = await makeTestApp();
  assert.equal((await t.app.inject({ url: '/vendor/opentype.mjs' })).statusCode, 200);
  assert.equal((await t.app.inject({ url: '/vendor/dagre.esm.js' })).statusCode, 200);
  assert.equal((await t.app.inject({ url: '/shared/render/render.js' })).statusCode, 200);
  await t.close();
});
