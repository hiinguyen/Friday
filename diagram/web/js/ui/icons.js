import { ICONS } from '../../../shared/icons/icons.js';
import { iconElement } from './dom.js';

// Interface glyphs missing from the diagram icon set (Lucide, ISC licence).
const UI_ICONS = {
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]],
  redo: [['path', { d: 'm15 14 5-5-5-5' }], ['path', { d: 'M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13' }]],
  panel: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M9 3v18' }]],
};

export function uiIcon(name, options) {
  return iconElement(UI_ICONS[name] ?? ICONS[name] ?? ICONS.circle, options);
}
