import { ICONS } from '../icons/icons.js';
import { FONT_FAMILY } from './fonts.js';
import { resolvePaint } from './themes.js';

const r2 = (value) => Math.round(value * 100) / 100;
const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function paintAttr(name, paint, theme) {
  const resolved = resolvePaint(paint, theme);
  if (!resolved) return ` ${name}="none"`;
  const opacity = resolved.opacity < 1 ? ` ${name}-opacity="${resolved.opacity}"` : '';
  return ` ${name}="${resolved.color}"${opacity}`;
}

function dataAttrs(item) {
  return `${item.nodeId ? ` data-node-id="${escapeXml(item.nodeId)}"` : ''}${item.role ? ` data-role="${item.role}"` : ''}`;
}

function radiusOf(item, theme) {
  if (item.radius === 'theme') return theme.radius;
  if (item.radius === 'pill') return item.h / 2;
  return item.radius ?? 0;
}

function strokeWidthAttr(item) {
  return item.strokeWidth != null ? ` stroke-width="${r2(item.strokeWidth)}"` : '';
}

function paintRect(item, theme) {
  const rx = r2(radiusOf(item, theme));
  const parts = [];
  if (item.shadow && theme.shadow) {
    parts.push(`<rect x="${r2(item.x)}" y="${r2(item.y + 3)}" width="${r2(item.w)}" height="${r2(item.h)}" rx="${rx}"${paintAttr('fill', { token: 'text', mix: 0.1 }, theme)} stroke="none"/>`);
  }
  parts.push(`<rect x="${r2(item.x)}" y="${r2(item.y)}" width="${r2(item.w)}" height="${r2(item.h)}" rx="${rx}"${paintAttr('fill', item.fill, theme)}${paintAttr('stroke', item.stroke, theme)}${strokeWidthAttr(item)}${dataAttrs(item)}/>`);
  return parts.join('');
}

function paintCircle(item, theme) {
  const parts = [];
  if (item.shadow && theme.shadow) {
    parts.push(`<circle cx="${r2(item.cx)}" cy="${r2(item.cy + 3)}" r="${r2(item.r)}"${paintAttr('fill', { token: 'text', mix: 0.1 }, theme)} stroke="none"/>`);
  }
  parts.push(`<circle cx="${r2(item.cx)}" cy="${r2(item.cy)}" r="${r2(item.r)}"${paintAttr('fill', item.fill, theme)}${paintAttr('stroke', item.stroke, theme)}${strokeWidthAttr(item)}${dataAttrs(item)}/>`);
  return parts.join('');
}

function paintPath(item, theme) {
  const dash = item.dash ? ' stroke-dasharray="5 5"' : '';
  return `<path d="${item.d}"${paintAttr('fill', item.fill, theme)}${paintAttr('stroke', item.stroke, theme)}${strokeWidthAttr(item)} stroke-linecap="round" stroke-linejoin="round"${dash}${dataAttrs(item)}/>`;
}

function paintText(item, theme, fontSet, textAsPaths) {
  const ascent = fontSet.ascent(item.size, item.weight);
  const descent = fontSet.descent(item.size, item.weight);
  const anchor = item.anchor === 'middle' ? 'middle' : item.anchor === 'end' ? 'end' : 'start';
  const out = [];
  item.lines.forEach((line, index) => {
    const baseline = item.y + index * item.lineHeight + (item.lineHeight + ascent - descent) / 2;
    if (textAsPaths) {
      const width = fontSet.measure(line, item.size, item.weight);
      const left = item.anchor === 'middle' ? item.x - width / 2 : item.anchor === 'end' ? item.x - width : item.x;
      out.push(`<path d="${fontSet.pathData(line, left, baseline, item.size, item.weight)}"${paintAttr('fill', item.fill, theme)}${dataAttrs(item)}/>`);
    } else {
      out.push(`<text x="${r2(item.x)}" y="${r2(baseline)}" font-size="${r2(item.size)}" font-weight="${item.weight}" text-anchor="${anchor}"${paintAttr('fill', item.fill, theme)}${dataAttrs(item)}>${escapeXml(line)}</text>`);
    }
  });
  return out.join('');
}

function paintIcon(item, theme, overrideColor) {
  const parts = ICONS[item.name] ?? ICONS.circle;
  const resolved = resolvePaint(overrideColor ?? item.color, theme);
  const color = resolved ? resolved.color : 'none';
  const shapes = parts.map(([tag, attrs]) => {
    const attributes = Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
    return `<${tag}${attributes}/>`;
  }).join('');
  return `<g transform="translate(${r2(item.x)} ${r2(item.y)}) scale(${r2(item.size / 24)})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${dataAttrs(item)}>${shapes}</g>`;
}

function isOutlineBadge(item, theme) {
  return theme.iconStyle === 'outline' && item.type === 'circle' && item.role === 'node-icon'
    && typeof item.fill === 'string' && /^accent[1-6]$/.test(item.fill);
}

export function sceneToSvg(scene, theme, { fontSet, textAsPaths = false, background = true } = {}) {
  const width = r2(scene.width);
  const height = r2(scene.height);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT_FAMILY}, sans-serif">`];
  if (background) parts.push(`<rect x="0" y="0" width="${width}" height="${height}"${paintAttr('fill', 'background', theme)} data-role="background"/>`);
  let outlineIconColor = null;
  for (const item of scene.items) {
    if (item.type === 'icon' && outlineIconColor !== null) {
      parts.push(paintIcon(item, theme, outlineIconColor));
      outlineIconColor = null;
      continue;
    }
    outlineIconColor = null;
    if (isOutlineBadge(item, theme)) {
      parts.push(paintCircle({ ...item, fill: { token: item.fill, mix: 0.14 }, stroke: item.fill, strokeWidth: 1.5 }, theme));
      outlineIconColor = item.fill;
      continue;
    }
    switch (item.type) {
      case 'rect': parts.push(paintRect(item, theme)); break;
      case 'circle': parts.push(paintCircle(item, theme)); break;
      case 'path': parts.push(paintPath(item, theme)); break;
      case 'text': parts.push(paintText(item, theme, fontSet, textAsPaths)); break;
      case 'icon': parts.push(paintIcon(item, theme)); break;
      default: throw new Error(`unknown scene item type "${item.type}"`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}
