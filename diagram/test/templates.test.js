import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFontSet } from '../server/render/fonts-node.js';
import { TEMPLATES, compatibleTemplates } from '../shared/render/registry.js';
import { renderSpec } from '../shared/render/render.js';
import { validateSpec } from '../shared/spec/validate.js';
import { assertSceneInvariants } from './helpers/scene.js';
import { sampleSpec } from './helpers/samples.js';

const fonts = loadFontSet();
const OVERLAPPING = new Set(['venn']);

for (const template of TEMPLATES) {
  for (const count of [template.minNodes, template.maxNodes]) {
    for (const long of [false, true]) {
      for (const density of ['compact', 'airy']) {
        test(`${template.id}: ${count} nodes, long=${long}, ${density}`, () => {
          const spec = sampleSpec(template, count, { long });
          const withDensity = { ...spec, style: { ...spec.style, density } };
          assert.deepEqual(validateSpec(withDensity), []);
          const { scene, svg } = renderSpec(withDensity, { fontSet: fonts });
          assertSceneInvariants(scene, withDensity, fonts, { allowNodeOverlap: OVERLAPPING.has(template.id) });
          assert.ok(svg.startsWith('<svg'));
          assert.ok(svg.includes('data-node-id="n1"'));
        });
      }
    }
  }

  test(`${template.id}: a single node renders without crashing`, () => {
    const spec = sampleSpec(template, template.minNodes);
    const one = { ...spec, nodes: [{ ...spec.nodes[0], parent: null }], edges: [] };
    const { scene } = renderSpec(one, { fontSet: fonts });
    assert.ok(scene.nodes.n1);
  });

  test(`${template.id}: accepts its own sample`, () => {
    const spec = sampleSpec(template, template.minNodes);
    const entry = compatibleTemplates(spec).find((t) => t.id === template.id);
    assert.equal(entry.ok, true, entry.reason);
  });
}
