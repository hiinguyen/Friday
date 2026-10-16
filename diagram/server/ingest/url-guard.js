import net from 'node:net';
import dns from 'node:dns';
import { AppError } from '../errors.js';

const blocked = new net.BlockList();
for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['224.0.0.0', 3, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]) {
  blocked.addSubnet(address, prefix, type);
}

export function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return blocked.check(ip, 'ipv6');
  return true;
}

function charsetOf(contentType) {
  const match = /charset=([^;]+)/i.exec(contentType ?? '');
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : 'utf-8';
}

function decode(buffer, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function readBody(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError('url_failed', 'Trang web quá lớn.');
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  return decode(buffer, response.headers.get('content-type'));
}

// The address check and the connection use separate DNS lookups, so a hostile DNS server
// could still race them (DNS rebinding). That is acceptable for a single-user tool behind
// a token.
export async function guardedFetch(url, {
  fetchImpl = fetch,
  lookup = dns.promises.lookup,
  maxBytes = 5 * 1024 * 1024,
  timeoutMs = 15000,
  maxRedirects = 3,
} = {}) {
  let current = url;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new AppError('url_blocked');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AppError('url_blocked');
    if (parsed.username || parsed.password) throw new AppError('url_blocked');

    let addresses;
    if (net.isIP(parsed.hostname)) addresses = [{ address: parsed.hostname }];
    else {
      try {
        addresses = await lookup(parsed.hostname, { all: true, order: 'ipv4first' });
      } catch (error) {
        throw new AppError('url_failed', undefined, { detail: error.message });
      }
    }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
      throw new AppError('url_blocked', 'Địa chỉ này trỏ vào mạng nội bộ.');
    }

    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'DiagramStudio/0.1', accept: 'text/html,text/plain;q=0.9' },
      });
    } catch (error) {
      throw new AppError('url_failed', undefined, { detail: error?.message ?? 'network error' });
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirect === maxRedirects) throw new AppError('url_failed', 'Trang chuyển hướng quá nhiều lần.');
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new AppError('url_failed', `Trang web trả về lỗi ${response.status}.`);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/html') && !contentType.startsWith('text/plain')) {
      throw new AppError('url_failed', 'Địa chỉ này không phải trang web có chữ.');
    }
    return { url: current, contentType, body: await readBody(response, maxBytes) };
  }
  throw new AppError('url_failed', 'Trang chuyển hướng quá nhiều lần.');
}
