import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { ingestText } from '../server/ingest/index.js';

test('creates, lists, saves and removes projects atomically', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-store-'));
  const store = createStore(dir);
  const project = await store.create({ document: ingestText('Một.\n\nHai.'), source: { buffer: Buffer.from('PK'), ext: 'docx' } });
  assert.match(project.id, /^p_\d{8}_[0-9a-f]{6}$/);
  assert.equal(project.sourceFile, 'source.docx');
  assert.deepEqual((await store.readSource(project)).toString(), 'PK');
  const saved = await store.save({ ...project, sections: [{ id: 's1', blockIds: ['b0'], title: 'A', summary: '', suggestedKinds: [] }] });
  assert.ok(saved.updatedAt >= project.updatedAt);
  assert.equal((await store.list())[0].sectionCount, 1);
  const files = await fs.readdir(path.join(dir, 'projects', project.id));
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  await store.remove(project.id);
  await assert.rejects(store.get(project.id), { code: 'not_found' });
  await assert.rejects(store.get('../../etc'), { code: 'not_found' });
  await fs.rm(dir, { recursive: true, force: true });
});
