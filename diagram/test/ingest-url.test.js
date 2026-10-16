import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, guardedFetch } from '../server/ingest/url-guard.js';
import { ingestUrl } from '../server/ingest/index.js';

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('private, loopback, link-local and metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('translation, 6to4, documentation, benchmark and reserved ranges are blocked', () => {
  for (const ip of [
    '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a9fe:a9fe', '2002:7f00:1::', '2002:a9fe:a9fe::',
    '::127.0.0.1', '2001:db8::1', '192.0.2.1', '198.51.100.7', '203.0.113.9', '240.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

test('refuses other schemes, credentials and hosts that resolve to private addresses', async () => {
  await assert.rejects(guardedFetch('file:///etc/passwd'), { code: 'url_blocked' });
  await assert.rejects(guardedFetch('http://user:pw@example.com/'), { code: 'url_blocked' });
  await assert.rejects(guardedFetch('http://127.0.0.1/'), { code: 'url_blocked' });
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(guardedFetch('http://mixed.example/', { lookup, fetchImpl: async () => html('x') }), { code: 'url_blocked' });
});

test('re-checks every redirect and caps their number', async () => {
  const toPrivate = async () => new Response('', { status: 302, headers: { location: 'http://localhost/admin' } });
  const lookup = async (host) => (host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  await assert.rejects(guardedFetch('http://a.example/', { lookup, fetchImpl: toPrivate }), { code: 'url_blocked' });
  let hops = 0;
  const loop = async () => { hops += 1; return new Response('', { status: 301, headers: { location: `/hop${hops}` } }); };
  await assert.rejects(guardedFetch('http://a.example/', { lookup: PUBLIC, fetchImpl: loop }), { code: 'url_failed' });
  assert.equal(hops, 4);
});

test('rejects bodies over the size cap and non-text content', async () => {
  const big = async () => html('x'.repeat(2000));
  await assert.rejects(guardedFetch('http://a.example/', { lookup: PUBLIC, fetchImpl: big, maxBytes: 1000 }), { code: 'url_failed' });
  const pdf = async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(guardedFetch('http://a.example/', { lookup: PUBLIC, fetchImpl: pdf }), { code: 'url_failed' });
});

test('a connection that re-resolves to a blocked address is refused (DNS rebinding)', async () => {
  let calls = 0;
  const lookup = async () => {
    calls += 1;
    return calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  };
  await assert.rejects(guardedFetch('http://rebind.example/', { lookup }), { code: 'url_blocked' });
  assert.ok(calls >= 2, `the connection-time lookup ran ${calls} time(s)`);
});

test('extracts the article into blocks', async () => {
  const page = `<!doctype html><html><head><title>Trang thử</title></head><body><nav>Menu</nav><article>
    <h1>Quy trình tuyển dụng</h1><p>Công ty tuyển dụng qua bốn bước rõ ràng, mỗi bước có người phụ trách riêng và thời hạn cụ thể.</p>
    <ol><li>Sàng lọc hồ sơ</li><li>Phỏng vấn</li><li>Bài kiểm tra</li><li>Đề nghị</li></ol>
    <p>Toàn bộ quy trình thường kéo dài khoảng ba tuần cho mỗi vị trí, tuỳ theo số lượng ứng viên.</p></article></body></html>`;
  const doc = await ingestUrl('https://jobs.example/quy-trinh', { lookup: PUBLIC, fetchImpl: async () => html(page) });
  assert.equal(doc.format, 'url');
  assert.ok(doc.blocks.some((b) => b.kind === 'list' && b.text.includes('- Phỏng vấn')));
  assert.ok(!doc.blocks.some((b) => b.text.includes('Menu')));
});
