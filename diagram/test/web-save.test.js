import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../web/js/editor/save.js';

test('saves only the latest spec per section after the delay, and flush sends at once', async () => {
  const sent = [];
  const saver = createSaver({ save: async (sid, spec) => { sent.push([sid, spec.title]); }, delayMs: 30 });
  saver.schedule('s1', { title: 'a' });
  saver.schedule('s1', { title: 'b' });
  saver.schedule('s2', { title: 'c' });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent.sort(), [['s1', 'b'], ['s2', 'c']]);
  saver.schedule('s1', { title: 'd' });
  await saver.flush();
  assert.deepEqual(sent.at(-1), ['s1', 'd']);
});
