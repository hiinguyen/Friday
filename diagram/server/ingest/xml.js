import zlib from 'node:zlib';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { AppError } from '../errors.js';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};

export function parseXml(text) {
  return new DOMParser().parseFromString(text, 'text/xml');
}

export function serializeXml(doc) {
  return new XMLSerializer().serializeToString(doc);
}

// Element children only, in order. This is the single definition of "body child index"
// shared by docx ingest and docx export.
export function childElements(node) {
  const result = [];
  if (!node || !node.childNodes) return result;
  for (let i = 0; i < node.childNodes.length; i += 1) {
    if (node.childNodes[i].nodeType === 1) result.push(node.childNodes[i]);
  }
  return result;
}

export function descendants(node, ns, localName) {
  if (!node || typeof node.getElementsByTagNameNS !== 'function') return [];
  return Array.from(node.getElementsByTagNameNS(ns, localName));
}

// Attribute value, accepting either a namespaced (w:val) or a plain (type) name.
export function attribute(element, ns, name) {
  if (!element || typeof element.getAttribute !== 'function') return null;
  const namespaced = typeof element.getAttributeNS === 'function' ? element.getAttributeNS(ns, name) : null;
  if (namespaced) return namespaced;
  const plain = element.getAttribute(name);
  return plain ? plain : null;
}

// Text of a paragraph: a:t / w:t runs in order, tabs as spaces, breaks as newlines.
export function textOfRuns(node, ns) {
  let text = '';
  for (const child of childElements(node)) {
    if (child.namespaceURI === ns && child.localName === 't') text += child.textContent;
    else if (child.namespaceURI === ns && child.localName === 'tab') text += ' ';
    else if (child.namespaceURI === ns && child.localName === 'br') text += '\n';
    else text += textOfRuns(child, ns);
  }
  return text;
}

const DC = 'http://purl.org/dc/elements/1.1/';
const BAD_OFFICE_FILE = 'Không đọc được tệp Office này.';
const ZIP_TOO_LARGE = 'Tệp nén quá lớn để xử lý an toàn.';

// JSZip decompresses lazily and has no size limit, so a tiny upload can expand to gigabytes.
// The sizes in the central directory are a cheap first filter, but an attacker writes them,
// so every read goes through readZipText, which inflates with a hard cap on the real output.
const ZIP_LIMITS = {
  entries: 2000,
  entryBytes: 25 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
};
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const budgets = new WeakMap();

function checkZipSize(zip) {
  const entries = Object.values(zip.files);
  if (entries.length > ZIP_LIMITS.entries) throw new AppError('bad_input', ZIP_TOO_LARGE);
  let total = 0;
  for (const entry of entries) {
    const size = entry._data ? entry._data.uncompressedSize : 0;
    const bytes = typeof size === 'number' && Number.isFinite(size) ? size : 0;
    if (bytes > ZIP_LIMITS.entryBytes) throw new AppError('bad_input', ZIP_TOO_LARGE);
    total += bytes;
    if (total > ZIP_LIMITS.totalBytes) throw new AppError('bad_input', ZIP_TOO_LARGE);
  }
}

export function isZip(buffer) {
  return Boolean(buffer) && buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export async function openZip(buffer) {
  if (!isZip(buffer)) throw new AppError('bad_input', BAD_OFFICE_FILE);
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new AppError('bad_input', BAD_OFFICE_FILE, { detail: error.message });
  }
  checkZipSize(zip);
  budgets.set(zip, { left: ZIP_LIMITS.totalBytes });
  return zip;
}

function inflateEntry(entry, limit) {
  const raw = entry._data?.compressedContent;
  const method = entry._data?.compression?.magic?.charCodeAt(0);
  if (!(raw instanceof Uint8Array)) throw new AppError('bad_input', BAD_OFFICE_FILE, { detail: `unreadable entry ${entry.name}` });
  if (method === METHOD_STORE) {
    if (raw.length > limit) throw new AppError('bad_input', ZIP_TOO_LARGE);
    return Buffer.from(raw);
  }
  if (method !== METHOD_DEFLATE) throw new AppError('bad_input', BAD_OFFICE_FILE, { detail: `unsupported method in ${entry.name}` });
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: limit });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new AppError('bad_input', ZIP_TOO_LARGE);
    throw new AppError('bad_input', BAD_OFFICE_FILE, { detail: error.message });
  }
}

// Text of one entry of a zip from openZip, or null when the entry does not exist. A modified
// entry (written with zip.file(name, text)) is read back through JSZip, since it is ours.
export async function readZipText(zip, name) {
  const entry = zip.file(name);
  if (!entry) return null;
  const budget = budgets.get(zip);
  if (!budget) throw new Error('readZipText needs a zip opened with openZip');
  if (!entry._data?.compressedContent) return entry.async('string');
  const bytes = inflateEntry(entry, Math.min(ZIP_LIMITS.entryBytes, budget.left));
  budget.left -= bytes.length;
  return bytes.toString('utf8');
}

export async function coreTitle(zip) {
  const xml = await readZipText(zip, 'docProps/core.xml');
  if (xml === null) return null;
  const doc = parseXml(xml);
  const title = descendants(doc, DC, 'title')[0];
  const text = title ? title.textContent.trim() : '';
  return text === '' ? null : text;
}
