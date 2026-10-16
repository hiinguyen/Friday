import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestFile } from '../server/ingest/index.js';
import { buildDocx, buildPptx } from './helpers/office.js';

test('docx paragraphs, headings, lists and tables become blocks with body indices', async () => {
  const buffer = await buildDocx([{ text: 'Quy trình', heading: 1 }, 'Bước đầu tiên là nghiên cứu.', { bullet: 'Một' }, { bullet: 'Hai' }, { table: [['A', 'B'], ['1', '2']] }, '']);
  const doc = await ingestFile({ filename: 'q.docx', buffer });
  assert.equal(doc.format, 'docx');
  assert.deepEqual(doc.blocks.map((b) => [b.kind, b.text]), [
    ['heading', 'Quy trình'], ['paragraph', 'Bước đầu tiên là nghiên cứu.'], ['list', '- Một\n- Hai'], ['table', 'A | B\n1 | 2'],
  ]);
  assert.deepEqual(doc.blocks.map((b) => b.source.bodyIndex), [0, 1, 3, 4]);
  assert.equal(doc.title, 'Quy trình');
});

test('pptx gives one block per slide in presentation order', async () => {
  const buffer = await buildPptx([{ title: 'Mở đầu', lines: ['Ý một', 'Ý hai'] }, { title: 'Kết luận', lines: [] }]);
  const doc = await ingestFile({ filename: 's.pptx', buffer });
  assert.equal(doc.format, 'pptx');
  assert.deepEqual(doc.blocks.map((b) => b.text), ['Mở đầu\nÝ một\nÝ hai', 'Kết luận']);
  assert.deepEqual(doc.blocks.map((b) => b.source.slideIndex), [0, 1]);
  assert.ok(doc.blocks[0].source.slidePart.startsWith('ppt/slides/slide'));
});
