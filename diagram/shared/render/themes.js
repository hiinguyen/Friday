import { mixHex } from './color.js';

const base = { strokeWidth: 1.5, font: 'Be Vietnam Pro' };

export const THEMES = {
  classic: { ...base, id: 'classic', label: 'Cổ điển', radius: 12, iconStyle: 'filled-circle', shadow: true,
    background: '#ffffff', surface: '#f6f8fb', text: '#1b2433', mutedText: '#556070', stroke: '#cfd6e0', onAccent: '#ffffff',
    accents: ['#1f6feb', '#0b7a70', '#7a4fd6', '#c2410c', '#b42358', '#3d6b1f'] },
  ocean: { ...base, id: 'ocean', label: 'Đại dương', radius: 16, iconStyle: 'filled-circle', shadow: true,
    background: '#f2f7fb', surface: '#ffffff', text: '#0c2235', mutedText: '#4a6075', stroke: '#c4d6e6', onAccent: '#ffffff',
    accents: ['#0b4f8a', '#0d6e8c', '#13788a', '#1d5f9e', '#28508f', '#0f6a6a'] },
  sunset: { ...base, id: 'sunset', label: 'Hoàng hôn', radius: 14, iconStyle: 'filled-circle', shadow: true,
    background: '#fffaf5', surface: '#ffffff', text: '#2b1a14', mutedText: '#6b5248', stroke: '#efd9c9', onAccent: '#ffffff',
    accents: ['#c2410c', '#b4235a', '#a63a12', '#9d2f6f', '#b45309', '#8f3b2e'] },
  pastel: { ...base, id: 'pastel', label: 'Pastel', radius: 18, iconStyle: 'filled-circle', shadow: false,
    background: '#fbfaff', surface: '#ffffff', text: '#2a2840', mutedText: '#5b5874', stroke: '#e2def2', onAccent: '#2a2840',
    accents: ['#c9d8ff', '#c6efe0', '#ffd9c7', '#f4cbe7', '#e3d7ff', '#fff0b8'] },
  mono: { ...base, id: 'mono', label: 'Đen trắng', radius: 4, iconStyle: 'outline', shadow: false,
    background: '#ffffff', surface: '#f4f4f4', text: '#111111', mutedText: '#4d4d4d', stroke: '#bdbdbd', onAccent: '#ffffff',
    accents: ['#111111', '#333333', '#4a4a4a', '#222222', '#3d3d3d', '#555555'] },
  midnight: { ...base, id: 'midnight', label: 'Nửa đêm', radius: 12, iconStyle: 'outline', shadow: false,
    background: '#0e1424', surface: '#172036', text: '#e8edf7', mutedText: '#a3afc6', stroke: '#2c3a58', onAccent: '#0b1020',
    accents: ['#5eead4', '#7dd3fc', '#c4b5fd', '#f9a8d4', '#fcd34d', '#86efac'] },
};

export const THEME_IDS = Object.keys(THEMES);

export function getTheme(id) {
  return THEMES[id] ?? THEMES.classic;
}

function tokenColor(token, theme) {
  const match = /^accent([1-6])$/.exec(token);
  if (match) return theme.accents[Number(match[1]) - 1];
  const color = theme[token];
  if (typeof color !== 'string') throw new Error(`unknown paint token "${token}"`);
  return color;
}

export function resolvePaint(paint, theme) {
  if (paint === 'none' || paint == null) return null;
  if (typeof paint === 'string') return { color: tokenColor(paint, theme), opacity: 1 };
  const color = tokenColor(paint.token, theme);
  if (typeof paint.mix === 'number') return { color: mixHex(color, theme.background, paint.mix), opacity: 1 };
  return { color, opacity: paint.opacity ?? 1 };
}
