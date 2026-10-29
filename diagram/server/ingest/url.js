import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { guardedFetch } from './url-guard.js';
import { parsePlainText } from './text.js';

function push(blocks, kind, text, extra = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value === '') return;
  blocks.push({ kind, text: value, ...extra });
}

function tableText(table) {
  return [...table.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('td, th')]
    .map((cell) => cell.textContent.replace(/\s+/g, ' ').trim())
    .join(' | ')).join('\n');
}

function listText(list) {
  return [...list.querySelectorAll('li')].map((item) => `- ${item.textContent.replace(/\s+/g, ' ').trim()}`).join('\n');
}

// Walk in document order; nested elements of a block already taken are not visited again.
function walk(root, blocks) {
  for (const child of root.children ?? []) {
    const tag = child.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      push(blocks, 'heading', child.textContent, { level: Number(tag[1]) });
      continue;
    }
    if (tag === 'p') {
      push(blocks, 'paragraph', child.textContent);
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      push(blocks, 'list', listText(child));
      continue;
    }
    if (tag === 'pre' || tag === 'blockquote') {
      push(blocks, 'paragraph', child.textContent);
      continue;
    }
    if (tag === 'table') {
      push(blocks, 'table', tableText(child));
      continue;
    }
    walk(child, blocks);
  }
}

function articleBlocks(html) {
  const { document } = parseHTML(html);
  let root = null;
  let title = null;
  try {
    const article = new Readability(document).parse();
    if (article && article.content) {
      title = article.title || null;
      root = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body;
    }
  } catch {
    root = null;
  }
  if (!root) {
    root = document.body;
    const titleElement = document.querySelector('title');
    title = titleElement ? titleElement.textContent : null;
  }
  const blocks = [];
  walk(root, blocks);
  return { blocks, title };
}

export async function loadUrl(url, deps = {}) {
  const { url: finalUrl, contentType, body } = await guardedFetch(url, deps);
  if (contentType.startsWith('text/plain')) {
    return { blocks: parsePlainText(body), title: null, url: finalUrl };
  }
  const { blocks, title } = articleBlocks(body);
  return { blocks, title, url: finalUrl };
}
