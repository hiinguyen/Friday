export const FONT_FAMILY = 'Be Vietnam Pro';
export const FONT_FILES = {
  400: 'BeVietnamPro-Regular.ttf',
  500: 'BeVietnamPro-Medium.ttf',
  600: 'BeVietnamPro-SemiBold.ttf',
  700: 'BeVietnamPro-Bold.ttf',
};

const MEASURE_CACHE_LIMIT = 20000;

export function createFontSet(opentype, buffers) {
  const fonts = {};
  for (const [weight, buffer] of Object.entries(buffers)) fonts[weight] = opentype.parse(buffer);
  if (!fonts[400]) throw new Error('the 400 weight is required');
  const pick = (weight) => fonts[weight] ?? fonts[400];
  const cache = new Map();
  return {
    measure(text, size, weight = 400) {
      const key = `${weight}|${size}|${text}`;
      let width = cache.get(key);
      if (width === undefined) {
        width = pick(weight).getAdvanceWidth(text, size, { kerning: true });
        if (cache.size > MEASURE_CACHE_LIMIT) cache.clear();
        cache.set(key, width);
      }
      return width;
    },
    pathData(text, x, baselineY, size, weight = 400) {
      return pick(weight).getPath(text, x, baselineY, size, { kerning: true }).toPathData(2);
    },
    ascent(size, weight = 400) {
      const font = pick(weight);
      return (font.ascender / font.unitsPerEm) * size;
    },
    descent(size, weight = 400) {
      const font = pick(weight);
      return (Math.abs(font.descender) / font.unitsPerEm) * size;
    },
  };
}
