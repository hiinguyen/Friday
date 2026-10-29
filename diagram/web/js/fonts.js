import * as opentype from '/vendor/opentype.mjs';
import { createFontSet, FONT_FILES } from '../../shared/render/fonts.js';

let cached = null;

export function loadBrowserFontSet() {
  if (cached) return cached;
  cached = (async () => {
    const buffers = {};
    for (const [weight, file] of Object.entries(FONT_FILES)) {
      const response = await fetch(`/shared/fonts/${file}`);
      if (!response.ok) throw new Error(`Không tải được phông ${file}`);
      buffers[weight] = await response.arrayBuffer();
    }
    return createFontSet(opentype, buffers);
  })();
  return cached;
}
