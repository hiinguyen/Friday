export const FONT_FAMILY = 'Be Vietnam Pro';
export const FONT_FILES = {
  400: 'BeVietnamPro-Regular.ttf',
  500: 'BeVietnamPro-Medium.ttf',
  600: 'BeVietnamPro-SemiBold.ttf',
  700: 'BeVietnamPro-Bold.ttf',
};

const MEASURE_CACHE_LIMIT = 20000;

// opentype.js 2 `Path.toPathData()` can emit NaN: its `roundDecimal` builds
// `decimalPart + 'e+' + places`, which breaks when `decimalPart` prints in exponent form
// (for example 5.68e-14). Serialise the commands ourselves with a plain rounding rule.
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function pathDataFromCommands(commands) {
  let data = '';
  for (const command of commands) {
    switch (command.type) {
      case 'M': data += `M${round2(command.x)} ${round2(command.y)}`; break;
      case 'L': data += `L${round2(command.x)} ${round2(command.y)}`; break;
      case 'Q': data += `Q${round2(command.x1)} ${round2(command.y1)} ${round2(command.x)} ${round2(command.y)}`; break;
      case 'C': data += `C${round2(command.x1)} ${round2(command.y1)} ${round2(command.x2)} ${round2(command.y2)} ${round2(command.x)} ${round2(command.y)}`; break;
      case 'Z': data += 'Z'; break;
      default: break;
    }
  }
  return data;
}

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
      return pathDataFromCommands(pick(weight).getPath(text, x, baselineY, size, { kerning: true }).commands);
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
