import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { makeTestApp, json } from './helpers/app.js';

const TEXT = '# Quy trình\n\nNghiên cứu.\n\nThiết kế.\n\nPhát triển.\n\n# Đo lường\n\nTheo dõi số liệu.';

async function projectWithTwoDiagrams(app) {
  const project = json(await app.inject({ method: 'POST', url: '/api/projects', payload: { text: TEXT } })).data;
  const seg = json(await app.inject({ method: 'POST', url: `/api/projects/${project.id}/segment`, payload: {} })).data;
  for (const section of seg.sections) {
    const gen = json(await app.inject({ method: 'POST', url: `/api/projects/${project.id}/sections/${section.id}/generate`, payload: {} })).data;
    await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/sections/${section.id}/diagram`, payload: { spec: gen.diagrams[section.id].candidates[0] } });
  }
  return { id: project.id, sections: seg.sections.map((s) => s.id) };
}

const pngWidth = (buffer) => buffer.readUInt32BE(16);

test('svg has text as paths, png is 2x, pdf has one page per diagram, zip links images', async () => {
  const t = await makeTestApp();
  const { id, sections } = await projectWithTwoDiagrams(t.app);
  const svg = await t.app.inject({ url: `/api/projects/${id}/export?format=svg&sections=${sections[0]}` });
  assert.equal(svg.statusCode, 200);
  assert.equal(svg.headers['content-type'], 'image/svg+xml; charset=utf-8');
  assert.ok(!svg.body.includes('<text'));
  const width = Number(/width="(\d+)"/.exec(svg.body)[1]);
  const png = await t.app.inject({ url: `/api/projects/${id}/export?format=png&sections=${sections[0]}` });
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(pngWidth(png.rawPayload), width * 2);
  assert.match(png.headers['content-disposition'], /attachment; filename="quy-trinh-s1\.png"/);
  const pdf = await t.app.inject({ url: `/api/projects/${id}/export?format=pdf` });
  assert.ok(pdf.rawPayload.subarray(0, 5).toString() === '%PDF-');
  assert.equal((pdf.rawPayload.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 2);
  const zip = await JSZip.loadAsync((await t.app.inject({ url: `/api/projects/${id}/export?format=zip` })).rawPayload);
  const md = await zip.file('diagrams.md').async('string');
  assert.ok(md.includes(`](images/${sections[0]}.png)`));
  assert.ok(zip.file(`images/${sections[1]}.png`));
  await t.close();
});

test('export errors are explicit', async () => {
  const t = await makeTestApp();
  const { id } = await projectWithTwoDiagrams(t.app);
  assert.equal(json(await t.app.inject({ url: `/api/projects/${id}/export?format=png` })).error.code, 'bad_input');
  assert.equal(json(await t.app.inject({ url: `/api/projects/${id}/export?format=docx` })).error.code, 'bad_input');
  const empty = json(await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một.' } })).data;
  assert.equal(json(await t.app.inject({ url: `/api/projects/${empty.id}/export?format=pdf` })).error.code, 'bad_input');
  await t.close();
});
