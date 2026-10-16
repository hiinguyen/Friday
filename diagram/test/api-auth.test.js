import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, json } from './helpers/app.js';

const TOKEN = 'secret-123';
const AUTH = { authorization: `Bearer ${TOKEN}` };
// /%61pi/%70rojects and friends decode to /api/projects at the router.
const ENCODED_PATHS = ['/api/projects', '/%61pi/projects', '/api/%70rojects', '/%61%70%69/projects'];

test('every path spelling of an API route needs the token', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_TOKEN: TOKEN } });
  for (const url of ENCODED_PATHS) {
    const denied = await t.app.inject({ url });
    assert.equal(denied.statusCode, 401, url);
    assert.equal(json(denied).error.code, 'unauthorized', url);
  }
  for (const url of ENCODED_PATHS) {
    const allowed = await t.app.inject({ url, headers: AUTH });
    assert.equal(allowed.statusCode, 200, url);
    assert.ok(Array.isArray(json(allowed).data), url);
  }
  await t.close();
});

test('write and export routes are covered through an encoded path', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_TOKEN: TOKEN } });
  const deniedPost = await t.app.inject({ method: 'POST', url: '/%61pi/projects', payload: { text: 'Một đoạn ngắn.' } });
  assert.equal(deniedPost.statusCode, 401);
  const deniedDelete = await t.app.inject({ method: 'DELETE', url: '/api/%70rojects/p_1' });
  assert.equal(deniedDelete.statusCode, 401);
  const deniedExport = await t.app.inject({ url: '/%61pi/%70rojects/p_1/export?format=png' });
  assert.equal(deniedExport.statusCode, 401);
  const deniedSegment = await t.app.inject({ method: 'POST', url: '/%61pi/projects/p_1/segment' });
  assert.equal(deniedSegment.statusCode, 401);

  const created = await t.app.inject({ method: 'POST', url: '/%61pi/projects', payload: { text: 'Một đoạn ngắn.' }, headers: AUTH });
  assert.equal(created.statusCode, 200);
  const id = json(created).data.id;
  const listed = await t.app.inject({ url: '/%61%70%69/projects', headers: AUTH });
  assert.deepEqual(json(listed).data.map((project) => project.id), [id]);
  const exported = await t.app.inject({ url: `/api/%70rojects/${id}/export?format=png`, headers: AUTH });
  assert.notEqual(exported.statusCode, 401);
  const deleted = await t.app.inject({ method: 'DELETE', url: `/api/%70rojects/${id}`, headers: AUTH });
  assert.equal(deleted.statusCode, 200);
  await t.close();
});

test('health stays open with a token configured', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_TOKEN: TOKEN } });
  for (const url of ['/api/health', '/%61pi/health']) {
    const health = await t.app.inject({ url });
    assert.equal(health.statusCode, 200, url);
    assert.deepEqual(json(health).data, { agent: 'fake', needsToken: true }, url);
  }
  await t.close();
});
