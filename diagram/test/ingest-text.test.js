import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestText, ingestFile } from '../server/ingest/index.js';

test('typed text splits into paragraphs, lists and headings', () => {
  const doc = ingestText('# Kế hoạch\n\nĐoạn mở đầu\nvẫn là đoạn đó.\n\n- Một\n- Hai\n\n1. Ba\n2. Bốn');
  assert.deepEqual(doc.blocks.map((b) => [b.id, b.kind]), [['b0', 'heading'], ['b1', 'paragraph'], ['b2', 'list'], ['b3', 'list']]);
  assert.equal(doc.blocks[0].text, 'Kế hoạch');
  assert.equal(doc.blocks[0].level, 1);
  assert.equal(doc.title, 'Kế hoạch');
});

test('a .txt file strips the BOM and CRLF', async () => {
  const doc = await ingestFile({ filename: 'a.TXT', buffer: Buffer.from('\uFEFFMột\r\n\r\nHai', 'utf8') });
  assert.equal(doc.format, 'txt');
  assert.deepEqual(doc.blocks.map((b) => b.text), ['Một', 'Hai']);
});

test('markdown keeps structure', async () => {
  const md = '# Tiêu đề\n\nĐoạn văn.\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';
  const doc = await ingestFile({ filename: 'x.md', buffer: Buffer.from(md) });
  assert.deepEqual(doc.blocks.map((b) => b.kind), ['heading', 'paragraph', 'list', 'table']);
  assert.equal(doc.blocks[2].text, '- a\n- b');
  assert.equal(doc.blocks[3].text, 'A | B\n1 | 2');
});

test('unsupported and empty inputs are rejected with bad_input', async () => {
  await assert.rejects(ingestFile({ filename: 'x.pdf', buffer: Buffer.from('%PDF') }), { code: 'bad_input' });
  await assert.rejects(ingestFile({ filename: 'x.txt', buffer: Buffer.from('   \n\n ') }), { code: 'bad_input' });
  await assert.rejects(ingestFile({ filename: 'x.docx', buffer: Buffer.from('not a zip') }), { code: 'bad_input' });
});
