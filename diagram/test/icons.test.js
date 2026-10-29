import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS, ICON_NAMES } from '../shared/icons/icons.js';
import { CURATED_ICONS } from '../shared/icons/names.js';

const ALLOWED_TAGS = new Set(['circle', 'path', 'rect', 'polyline', 'ellipse', 'line', 'polygon']);

test('every curated icon is generated', () => {
  assert.deepEqual(ICON_NAMES, CURATED_ICONS);
  assert.ok(ICON_NAMES.includes('circle'), 'circle is the fallback icon');
});

test('icons only use plain shape tags', () => {
  for (const [name, parts] of Object.entries(ICONS)) {
    assert.ok(parts.length > 0, name);
    for (const [tag, attrs] of parts) {
      assert.ok(ALLOWED_TAGS.has(tag), `${name} uses ${tag}`);
      assert.equal(typeof attrs, 'object');
    }
  }
});
