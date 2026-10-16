import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { openZip } from '../server/ingest/xml.js';
import { makeTestApp, json } from './helpers/app.js';

async function zipBuffer(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('openZip refuses an archive with too many entries', async () => {
  const files = {};
  for (let i = 0; i < 2001; i += 1) files[`f${i}.xml`] = 'x';
  await assert.rejects(openZip(await zipBuffer(files)), { code: 'bad_input' });
});

test('openZip refuses a single entry over 25 MB', async () => {
  const xml = `<w:document>${'x'.repeat(26 * 1024 * 1024)}</w:document>`;
  const buffer = await zipBuffer({ 'word/document.xml': xml });
  assert.ok(buffer.length < 1024 * 1024, 'the bomb stays tiny compressed');
  await assert.rejects(openZip(buffer), { code: 'bad_input' });
});

test('openZip refuses a total over 100 MB even when every entry is small', async () => {
  const chunk = 'y'.repeat(21 * 1024 * 1024);
  const files = {};
  for (let i = 0; i < 5; i += 1) files[`big${i}.xml`] = chunk;
  await assert.rejects(openZip(await zipBuffer(files)), { code: 'bad_input' });
});

test('a compressed bomb is refused at upload and the server keeps answering', async () => {
  const t = await makeTestApp();
  const xml = `<w:document>${'x'.repeat(30 * 1024 * 1024)}</w:document>`;
  const buffer = await zipBuffer({ 'word/document.xml': xml });
  const boundary = '----diagrambomb';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bomb.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'bad_input');
  assert.equal((await t.app.inject({ url: '/api/health' })).statusCode, 200);
  await t.close();
});
