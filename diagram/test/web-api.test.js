import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../web/js/api.js';

test('unwraps envelopes, sends the token and maps errors', async () => {
  const calls = [];
  let unauthorized = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/projects') return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Cần mã truy cập hợp lệ.' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const api = createApi({ fetchImpl, getToken: () => 'tok', onUnauthorized: () => { unauthorized += 1; } });
  assert.deepEqual(await api.listProjects(), []);
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer tok');
  await assert.rejects(api.getProject('p_1'), { code: 'unauthorized', status: 401 });
  assert.equal(unauthorized, 1);
});

test('network failures become a Vietnamese network error', async () => {
  const api = createApi({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, getToken: () => null, onUnauthorized: () => {} });
  await assert.rejects(api.health(), { code: 'network', message: 'Không kết nối được máy chủ.' });
});

test('exportFile returns the blob and the server file name', async () => {
  const fetchImpl = async () => new Response('png-bytes', { status: 200, headers: { 'content-type': 'image/png', 'content-disposition': `attachment; filename="a.png"; filename*=UTF-8''quy-tr%C3%ACnh.png` } });
  const api = createApi({ fetchImpl, getToken: () => null, onUnauthorized: () => {} });
  const { blob, filename } = await api.exportFile('p_1', { format: 'png', sections: ['s1'] });
  assert.equal(filename, 'quy-trình.png');
  assert.equal(await blob.text(), 'png-bytes');
});
