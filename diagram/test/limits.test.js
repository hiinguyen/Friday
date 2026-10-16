import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, json } from './helpers/app.js';

const LONG = '# Quy trình\n\nNghiên cứu khách hàng.\n\nThiết kế giải pháp.\n\nPhát triển sản phẩm.\n\n# Đo lường\n\nTheo dõi số liệu sau khi ra mắt.';

test('too many failed token attempts turn into 429', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_TOKEN: 'secret-123', DIAGRAM_AUTH_ATTEMPTS_PER_MINUTE: '3' } });
  assert.equal((await t.app.inject({ url: '/api/projects', headers: { authorization: 'Bearer secret-123' } })).statusCode, 200);
  for (let i = 0; i < 3; i += 1) {
    const denied = await t.app.inject({ url: '/api/projects', headers: { authorization: 'Bearer nope' } });
    assert.equal(denied.statusCode, 401, `attempt ${i + 1}`);
  }
  const limited = await t.app.inject({ url: '/api/projects', headers: { authorization: 'Bearer nope' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(json(limited).error.code, 'too_many');
  await t.close();
});

test('agent routes are limited per minute', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_AGENT_CALLS_PER_MINUTE: '2' } });
  const project = json(await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: LONG } })).data;
  const url = `/api/projects/${project.id}/segment`;
  assert.equal((await t.app.inject({ method: 'POST', url, payload: {} })).statusCode, 200);
  assert.equal((await t.app.inject({ method: 'POST', url, payload: {} })).statusCode, 200);
  const limited = await t.app.inject({ method: 'POST', url, payload: {} });
  assert.equal(limited.statusCode, 429);
  assert.equal(json(limited).error.code, 'too_many');
  await t.close();
});

test('the store refuses to grow past its project cap', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_MAX_PROJECTS: '2' } });
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' } })).statusCode, 200);
  assert.equal((await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Hai đoạn.' } })).statusCode, 200);
  const full = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Ba đoạn.' } });
  assert.equal(full.statusCode, 400);
  assert.equal(json(full).error.code, 'bad_input');
  assert.match(json(full).error.message, /dự án/);
  await t.close();
});
