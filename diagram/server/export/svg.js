import { renderSpec } from '../../shared/render/render.js';

export function exportSvg(spec, fontSet) {
  return renderSpec(spec, { fontSet, textAsPaths: true, background: true }).svg;
}
