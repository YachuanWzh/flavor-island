'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, normalizeSettings } = require('../src/core/settings');

test('settings default to privacy-safe local behavior', () => {
  const settings = normalizeSettings();
  assert.equal(settings.privacyMode, true);
  assert.equal(settings.sounds, true);
  assert.equal(settings.autoExpand, true);
  assert.deepEqual(settings.pricing, DEFAULT_SETTINGS.pricing);
});

test('settings reject invalid motion and clamp pricing', () => {
  const settings = normalizeSettings({ motion: 'warp', pricing: { inputPerMillion: -3, outputPerMillion: '2.5' } });
  assert.equal(settings.motion, 'system');
  assert.equal(settings.pricing.inputPerMillion, 0);
  assert.equal(settings.pricing.outputPerMillion, 2.5);
});
