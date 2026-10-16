import { Resvg } from '@resvg/resvg-js';
import { renderSpec } from '../../shared/render/render.js';

export function exportPng(spec, fontSet, { transparent = false, scale = 2 } = {}) {
  const svg = renderSpec(spec, { fontSet, textAsPaths: true, background: !transparent }).svg;
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: scale } }).render().asPng();
}
