'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  sounds: true,
  autoExpand: true,
  launchAtLogin: false,
  motion: 'system',
  privacyMode: true,
  pricing: Object.freeze({
    inputPerMillion: 0,
    outputPerMillion: 0,
    cacheReadPerMillion: 0,
    cacheCreationPerMillion: 0,
  }),
});

function finiteRate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100000, Math.max(0, number)) : 0;
}

function normalizeSettings(value = {}) {
  const pricing = value.pricing && typeof value.pricing === 'object' ? value.pricing : {};
  return {
    sounds: typeof value.sounds === 'boolean' ? value.sounds : DEFAULT_SETTINGS.sounds,
    autoExpand: typeof value.autoExpand === 'boolean' ? value.autoExpand : DEFAULT_SETTINGS.autoExpand,
    launchAtLogin: typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    motion: ['system', 'full', 'reduced'].includes(value.motion) ? value.motion : DEFAULT_SETTINGS.motion,
    privacyMode: typeof value.privacyMode === 'boolean' ? value.privacyMode : DEFAULT_SETTINGS.privacyMode,
    pricing: {
      inputPerMillion: finiteRate(pricing.inputPerMillion),
      outputPerMillion: finiteRate(pricing.outputPerMillion),
      cacheReadPerMillion: finiteRate(pricing.cacheReadPerMillion),
      cacheCreationPerMillion: finiteRate(pricing.cacheCreationPerMillion),
    },
  };
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings };
