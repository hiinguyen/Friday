import path from 'node:path';
import { AppError } from '../errors.js';
import { parsePlainText, parseMarkdown } from './text.js';
import { parseDocx } from './docx.js';
import { parsePptx } from './pptx.js';
import { loadUrl } from './url.js';

function deriveTitle(blocks) {
  const heading = blocks.find((block) => block.kind === 'heading');
  const source = heading ? heading.text : (blocks[0] ? blocks[0].text : '');
  return source.slice(0, 60);
}

export function buildDocument(blocks, { format, title = null, url = null } = {}) {
  if (blocks.length === 0) throw new AppError('bad_input', 'Không tìm thấy nội dung chữ trong tệp.');
  const withIds = blocks.map((block, index) => ({
    id: `b${index}`,
    kind: block.kind,
    text: block.text,
    ...(block.level !== undefined ? { level: block.level } : {}),
    source: block.source ?? null,
  }));
  const document = { format, title: (title && title.trim()) || deriveTitle(withIds), blocks: withIds };
  if (url) document.url = url;
  return document;
}

export function ingestText(text) {
  return buildDocument(parsePlainText(text), { format: 'text' });
}

export async function ingestUrl(url, deps = {}) {
  const { blocks, title, url: finalUrl } = await loadUrl(url, deps);
  return buildDocument(blocks, { format: 'url', title, url: finalUrl });
}

export async function ingestFile({ filename, buffer }) {
  const extension = path.extname(String(filename ?? '')).toLowerCase();
  if (extension === '.txt') return buildDocument(parsePlainText(buffer.toString('utf8')), { format: 'txt' });
  if (extension === '.md' || extension === '.markdown') return buildDocument(parseMarkdown(buffer.toString('utf8')), { format: 'md' });
  if (extension === '.docx') {
    const { blocks, title } = await parseDocx(buffer);
    return buildDocument(blocks, { format: 'docx', title });
  }
  if (extension === '.pptx') {
    const { blocks, title } = await parsePptx(buffer);
    return buildDocument(blocks, { format: 'pptx', title });
  }
  throw new AppError('bad_input', 'Chỉ hỗ trợ .txt, .md, .docx, .pptx.');
}
