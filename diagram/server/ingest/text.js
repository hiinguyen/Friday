import { lexer } from 'marked';

const LIST_LINE = /^\s*([-*\u2022]|\d+[.)])\s+/;
const HEADING_LINE = /^#{1,6}\s+/;

function clean(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC');
}

function pushBlock(blocks, kind, text, extra = {}) {
  const value = String(text ?? '').trim();
  if (value === '') return;
  blocks.push({ kind, text: value, ...extra });
}

// Typed text and .txt: blank lines split blocks; a chunk of list lines is one list;
// a single "# ..." line is a heading; everything else is a paragraph.
export function parsePlainText(text) {
  const blocks = [];
  for (const chunk of clean(text).split(/\n\s*\n/)) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const lines = trimmed.split('\n');
    if (lines.every((line) => LIST_LINE.test(line))) {
      pushBlock(blocks, 'list', lines.map((line) => line.trim()).join('\n'));
    } else if (lines.length === 1 && HEADING_LINE.test(lines[0])) {
      pushBlock(blocks, 'heading', lines[0].replace(HEADING_LINE, ''), { level: lines[0].match(/^#+/)[0].length });
    } else {
      pushBlock(blocks, 'paragraph', lines.map((line) => line.trim()).join('\n'));
    }
  }
  return blocks;
}

export function parseMarkdown(text) {
  const blocks = [];
  for (const token of lexer(clean(text))) {
    switch (token.type) {
      case 'heading':
        pushBlock(blocks, 'heading', token.text, { level: token.depth });
        break;
      case 'paragraph':
        pushBlock(blocks, 'paragraph', token.text);
        break;
      case 'list':
        pushBlock(blocks, 'list', token.items.map((item) => `- ${String(item.text ?? '').trim()}`).join('\n'));
        break;
      case 'code':
        pushBlock(blocks, 'paragraph', token.text);
        break;
      case 'blockquote':
        pushBlock(blocks, 'paragraph', token.text);
        break;
      case 'table':
        pushBlock(blocks, 'table', [token.header, ...token.rows]
          .map((row) => row.map((cell) => String(cell.text ?? '').trim()).join(' | '))
          .join('\n'));
        break;
      default:
        break;
    }
  }
  return blocks;
}
