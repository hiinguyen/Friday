import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, json } from './helpers/app.js';

const PORT = 8790;

test('a foreign Host header is refused, a local one is allowed', async () => {
  const t = await makeTestApp();
  for (const host of ['evil.example', '2130706433:8790', 'localhost:9999', '127.0.0.1:8790.evil']) {
    const denied = await t.app.inject({ url: '/api/projects', headers: { host } });
    assert.equal(denied.statusCode, 403, host);
    assert.equal(json(denied).error.code, 'forbidden', host);
  }
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
    assert.equal((await t.app.inject({ url: '/api/projects', headers: { host } })).statusCode, 200, host);
  }
  await t.close();
});

test('a cross-site Origin on a write is refused, same-origin is allowed', async () => {
  const t = await makeTestApp();
  const crossSite = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' }, headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(json(crossSite).error.code, 'forbidden');

  const sameOrigin = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' }, headers: { origin: `http://127.0.0.1:${PORT}` } });
  assert.equal(sameOrigin.statusCode, 200);
  assert.ok(json(sameOrigin).data.id.startsWith('p_'));

  // A state-changing request with no Origin (curl, server to server) is still allowed.
  const noOrigin = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' } });
  assert.equal(noOrigin.statusCode, 200);
  await t.close();
});

test('DIAGRAM_PUBLIC_ORIGIN is trusted for a reverse proxy', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_PUBLIC_ORIGIN: 'https://diagrams.example.com' } });
  const host = await t.app.inject({ url: '/api/projects', headers: { host: 'diagrams.example.com' } });
  assert.equal(host.statusCode, 200);
  const origin = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' }, headers: { host: 'diagrams.example.com', origin: 'https://diagrams.example.com' } });
  assert.equal(origin.statusCode, 200);
  const otherOrigin = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' }, headers: { host: 'diagrams.example.com', origin: 'https://evil.example' } });
  assert.equal(otherOrigin.statusCode, 403);
  await t.close();
});

test('a public origin written with its default port still matches the browser Origin', async () => {
  const t = await makeTestApp({ env: { DIAGRAM_PUBLIC_ORIGIN: 'https://diagrams.example.com:443/' } });
  const res = await t.app.inject({ method: 'POST', url: '/api/projects', payload: { text: 'Một đoạn.' }, headers: { host: 'diagrams.example.com', origin: 'https://diagrams.example.com' } });
  assert.equal(res.statusCode, 200);
  await t.close();
});
