import { getTemplate } from './registry.js';
import { getTheme } from './themes.js';
import { getDensity } from './density.js';
import { sceneToSvg } from './svg.js';

export function layoutSpec(spec, fontSet) {
  const template = getTemplate(spec.template);
  return template.layout(spec, { fontSet, density: getDensity(spec.style?.density) });
}

export function paintScene(scene, spec, fontSet, { textAsPaths = false, background = true } = {}) {
  return sceneToSvg(scene, getTheme(spec.style?.theme), { fontSet, textAsPaths, background });
}

export function renderSpec(spec, { fontSet, textAsPaths = false, background = true }) {
  const scene = layoutSpec(spec, fontSet);
  return { scene, svg: paintScene(scene, spec, fontSet, { textAsPaths, background }) };
}
