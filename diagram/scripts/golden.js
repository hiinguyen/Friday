import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { loadFontSet } from '../server/render/fonts-node.js';
import { renderSpec } from '../shared/render/render.js';
import { TEMPLATES } from '../shared/render/registry.js';
import { THEME_IDS } from '../shared/render/themes.js';
import { sampleSpec } from '../test/helpers/samples.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function goldenCases() {
  const fontSet = loadFontSet();
  const cases = [];
  for (const template of TEMPLATES) {
    const spec = sampleSpec(template, Math.min(template.maxNodes, 6));
    cases.push({ file: `${template.id}.svg`, render: () => renderSpec(spec, { fontSet }).svg });
    if (template.id === 'cards' || template.id === 'timeline') {
      for (const theme of THEME_IDS) {
        if (theme === 'classic') continue;
        const themed = { ...spec, style: { ...spec.style, theme } };
        cases.push({ file: `${template.id}-${theme}.svg`, render: () => renderSpec(themed, { fontSet }).svg });
      }
    }
  }
  return cases;
}

function main() {
  const dir = path.join(root, 'test', 'golden');
  const preview = path.join(dir, 'preview');
  fs.mkdirSync(preview, { recursive: true });
  for (const { file, render } of goldenCases()) {
    const svg = render();
    fs.writeFileSync(path.join(dir, file), svg);
    fs.writeFileSync(path.join(preview, file.replace(/\.svg$/, '.png')), new Resvg(svg).render().asPng());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
