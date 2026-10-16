import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { goldenCases } from '../scripts/golden.js';

for (const { file, render } of goldenCases()) {
  test(`golden ${file}`, () => {
    const expected = fs.readFileSync(new URL(`./golden/${file}`, import.meta.url), 'utf8');
    assert.equal(render(), expected, `${file} changed: run npm run golden:update and review test/golden/preview`);
  });
}
