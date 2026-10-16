import net from 'node:net';
import dns from 'node:dns';
import { Agent } from 'undici';
import { AppError } from '../errors.js';

const blocked = new net.BlockList();
for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['224.0.0.0', 3, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['255.255.255.255', 32, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
  ['::', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['2002::', 16, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
]) {
  blocked.addSubnet(address, prefix, type);
}

// NAT64 (64:ff9b::/96 and 64:ff9b:1::/48), 6to4 (2002::/16) and IPv4-compatible (::/96)
// carry an IPv4 address inside the IPv6 one; block it when that embedded address is blocked.
function embeddedIPv4(ip) {
  const [head, tail] = ip.split('::');
  const parse = (text) => {
    const groups = [];
    if (text === '' || text === undefined) return groups;
    for (const part of text.split(':')) {
      if (part.includes('.')) {
        const [a, b, c, d] = part.split('.').map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
      } else {
        groups.push(parseInt(part, 16) & 0xffff);
      }
    }
    return groups;
  };
  let groups;
  if (tail === undefined) {
    groups = parse(head);
  } else {
    const left = parse(head);
    const right = parse(tail);
    if (left.length + right.length > 8) return null;
    groups = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  }
  if (groups.length !== 8) return null;
  const quad = (high, low) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) return quad(groups[6], groups[7]);
  if (groups[0] === 0x2002) return quad(groups[1], groups[2]);
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return quad(groups[6], groups[7]);
  }
  return null;
}

export function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    if (blocked.check(ip, 'ipv6')) return true;
    const embedded = embeddedIPv4(ip);
    return embedded === null ? false : blocked.check(embedded, 'ipv4');
  }
  return true;
}

const BLOCKED_MARKER = 'DIAGRAM_SSRF_BLOCKED';
const BLOCKED_MESSAGE = 'Địa chỉ này trỏ vào mạng nội bộ.';

function blockedLookupError() {
  return Object.assign(new Error('the address resolves into a blocked network'), { code: BLOCKED_MARKER });
}

function isBlockedLookupError(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (current.code === BLOCKED_MARKER) return true;
  }
  return false;
}

function addressList(resolved) {
  if (Array.isArray(resolved)) return resolved;
  if (resolved && typeof resolved.address === 'string') return [resolved];
  return [];
}

// The address check and the connection must use the same resolution, otherwise a TTL-0
// name can answer with a public address first and a loopback one second (DNS rebinding).
// The connection passes through this lookup, so the address we connect to is the one we checked.
export function createGuardedLookup(lookup) {
  return function guardedLookup(hostname, options, callback) {
    const wantsAll = typeof options === 'function' ? false : Boolean(options && options.all);
    const done = typeof options === 'function' ? options : callback;
    const resolved = net.isIP(hostname)
      ? Promise.resolve([{ address: hostname }])
      : Promise.resolve().then(() => lookup(hostname, { all: true, order: 'ipv4first' }));
    resolved
      .then((value) => {
        const list = addressList(value);
        if (list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
          done(blockedLookupError());
          return;
        }
        if (wantsAll) done(null, list);
        else done(null, list[0].address, list[0].family ?? (net.isIPv6(list[0].address) ? 6 : 4));
      })
      .catch((error) => done(error));
  };
}

export function createGuardDispatcher(lookup) {
  return new Agent({ connect: { lookup: createGuardedLookup(lookup) } });
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

// The address check and the connection share one lookup (through the dispatcher), so a
// hostile DNS server cannot re-resolve a name to a blocked address after the check.
export async function guardedFetch(url, {
  fetchImpl = fetch,
  lookup = dns.promises.lookup,
  dispatcher,
  maxBytes = 5 * 1024 * 1024,
  timeoutMs = 15000,
  maxRedirects = 3,
} = {}) {
  const guard = dispatcher ?? createGuardDispatcher(lookup);
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    let current = url;
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      if (deadline.aborted) throw new AppError('url_failed', 'Hết thời gian tải trang.');
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
          // A name that does not resolve is refused like a blocked one, so the client cannot
          // tell the two apart and use that as an SSRF oracle.
          throw new AppError('url_blocked', BLOCKED_MESSAGE, { detail: error.message });
        }
      }
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
        throw new AppError('url_blocked', BLOCKED_MESSAGE);
      }

      let response;
      try {
        response = await fetchImpl(current, {
          redirect: 'manual',
          signal: deadline,
          dispatcher: guard,
          headers: { 'user-agent': 'DiagramStudio/0.1', accept: 'text/html,text/plain;q=0.9' },
        });
      } catch (error) {
        if (isBlockedLookupError(error)) throw new AppError('url_blocked', BLOCKED_MESSAGE);
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
  } finally {
    if (!dispatcher && typeof guard.close === 'function') await guard.close().catch(() => {});
  }
}
