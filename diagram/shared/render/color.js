export function parseHex(hex) {
  const value = String(hex).trim().replace(/^#/, '');
  const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: "${hex}"`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

export function toHex({ r, g, b }) {
  return `#${[r, g, b].map((channel) => clamp(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function mixHex(fg, bg, amount) {
  const front = parseHex(fg);
  const back = parseHex(bg);
  return toHex({
    r: front.r * amount + back.r * (1 - amount),
    g: front.g * amount + back.g * (1 - amount),
    b: front.b * amount + back.b * (1 - amount),
  });
}

function channelLuminance(channel) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(hexA, hexB) {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
