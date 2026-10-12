'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSampler } = require('../src/stats');

test('samples bounded, well-typed telemetry', () => {
  const sample = createSampler();
  const stats = sample();
  for (const key of ['cpu', 'mem']) {
    assert.ok(stats[key] >= 0 && stats[key] <= 1, `${key}=${stats[key]} out of range`);
  }
  assert.ok(stats.netDown >= 0 && stats.netUp >= 0);
  assert.ok(stats.uptime > 0);
  assert.ok(stats.cores >= 1);
  assert.equal(typeof stats.user, 'string');
  if (stats.battery) {
    assert.ok(stats.battery.capacity >= 0 && stats.battery.capacity <= 100);
    assert.equal(typeof stats.battery.charging, 'boolean');
  }
});
