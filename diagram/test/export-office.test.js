import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { makeTestApp, json } from './helpers/app.js';
import { buildDocx, buildPptx } from './helpers/office.js';
import { convertWithSoffice } from './helpers/soffice.js';
import { ingestFile } from '../server/ingest/index.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function upload(app, filename, buffer) {
  const boundary = '----diagramtest';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buffer, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return json(await app.inject({ method: 'POST', url: '/api/projects', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })).data;
}

async function chooseAll(app, id) {
  const seg = json(await app.inject({ method: 'POST', url: `/api/projects/${id}/segment`, payload: {} })).data;
  for (const s of seg.sections) {
    const gen = json(await app.inject({ method: 'POST', url: `/api/projects/${id}/sections/${s.id}/generate`, payload: {} })).data;
    await app.inject({ method: 'PUT', url: `/api/projects/${id}/sections/${s.id}/diagram`, payload: { spec: gen.diagrams[s.id].candidates[0] } });
  }
  return seg.sections;
}

const textOf = (el) => Array.from(el.getElementsByTagNameNS(W, 't')).map((t) => t.textContent).join('');

test('docx: one picture paragraph right after each section, original text intact, Office can open it', async () => {
  const t = await makeTestApp();
  const source = await buildDocx([{ text: 'Quy trình', heading: 1 }, 'Nghiên cứu.', 'Thiết kế.', 'Phát triển.', { text: 'Đo lường', heading: 1 }, 'Theo dõi số liệu.', 'Báo cáo hằng tuần.']);
  const project = await upload(t.app, 'plan.docx', source);
  const sections = await chooseAll(t.app, project.id);
  const res = await t.app.inject({ url: `/api/projects/${project.id}/export?format=docx` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const zip = await JSZip.loadAsync(res.rawPayload);
  const doc = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'text/xml');
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const children = Array.from(body.childNodes).filter((n) => n.nodeType === 1);
  const pictures = children.filter((el) => el.getElementsByTagNameNS(W, 'drawing').length > 0);
  assert.equal(pictures.length, sections.length);
  const lastTexts = sections.map((s) => project.document.blocks.find((b) => b.id === s.blockIds[s.blockIds.length - 1]).text);
  pictures.forEach((pic, i) => {
    const prev = children[children.indexOf(pic) - 1];
    assert.equal(textOf(prev), lastTexts[i]);
  });
  assert.ok(Object.keys(zip.files).some((f) => /^word\/media\/diagram-s1\.png$/.test(f)));
  assert.match(await zip.file('[Content_Types].xml').async('string'), /Extension="png"/);
  const again = await ingestFile({ filename: 'again.docx', buffer: res.rawPayload });
  assert.deepEqual(again.blocks.map((b) => b.text), project.document.blocks.map((b) => b.text));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-docx-'));
  const file = path.join(dir, 'out.docx');
  await fs.writeFile(file, res.rawPayload);
  const pdf = await convertWithSoffice(file);
  if (pdf) assert.ok((await fs.stat(pdf)).size > 1000);
  await fs.rm(dir, { recursive: true, force: true });
  await t.close();
});

test('pptx: a new picture slide right after each section, Office can open it', async () => {
  const t = await makeTestApp();
  const source = await buildPptx([
    { title: 'Mở đầu', lines: ['Giới thiệu dự án'] },
    { title: 'Quy trình', lines: ['Nghiên cứu', 'Thiết kế', 'Phát triển', 'Ra mắt'] },
    { title: 'Kết luận', lines: ['Cảm ơn'] },
  ]);
  const project = await upload(t.app, 'deck.pptx', source);
  const sections = await chooseAll(t.app, project.id);
  const res = await t.app.inject({ url: `/api/projects/${project.id}/export?format=pptx` });
  assert.equal(res.statusCode, 200);
  const zip = await JSZip.loadAsync(res.rawPayload);
  const pres = new DOMParser().parseFromString(await zip.file('ppt/presentation.xml').async('string'), 'text/xml');
  const ids = Array.from(pres.getElementsByTagNameNS(P, 'sldId'));
  assert.equal(ids.length, 3 + sections.length);
  const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  const targetOf = (rid) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels).slice(1).find(Boolean);
  const order = ids.map((el) => targetOf(el.getAttributeNS(R, 'id')));
  const newSlides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
  assert.equal(newSlides, 3 + sections.length);
  const lastSlideOfSection = (s) => project.document.blocks.find((b) => b.id === s.blockIds[s.blockIds.length - 1]).source.slidePart.replace('ppt/', '');
  for (const s of sections) {
    const index = order.indexOf(lastSlideOfSection(s));
    const next = await zip.file(`ppt/${order[index + 1]}`).async('string');
    assert.ok(next.includes('<p:pic>'), `slide after ${lastSlideOfSection(s)} is the diagram`);
  }
  const again = await ingestFile({ filename: 'again.pptx', buffer: res.rawPayload });
  assert.deepEqual(again.blocks.map((b) => b.text), project.document.blocks.map((b) => b.text));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-pptx-'));
  const file = path.join(dir, 'out.pptx');
  await fs.writeFile(file, res.rawPayload);
  const pdf = await convertWithSoffice(file);
  if (pdf) assert.ok((await fs.stat(pdf)).size > 1000);
  await fs.rm(dir, { recursive: true, force: true });
  await t.close();
});
