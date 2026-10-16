import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { createFontSet, FONT_FILES } from '../../shared/render/fonts.js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'fonts');
let cached = null;

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export function loadFontSet() {
  if (cached) return cached;
  const buffers = {};
  for (const [weight, file] of Object.entries(FONT_FILES)) buffers[weight] = toArrayBuffer(fs.readFileSync(path.join(FONT_DIR, file)));
  cached = createFontSet(opentype, buffers);
  return cached;
}
