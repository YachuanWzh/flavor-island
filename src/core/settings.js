'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  sounds: true,
  autoExpand: true,
  launchAtLogin: false,
  motion: 'system',
  privacyMode: true,
  // Notch fusion. On macOS it is auto-detected; on Windows there is no API to
  // read the cutout, so the user opts in and types the physical notch size
  // (logical px). `notchMode: 'auto'` = mac-only; `'on'` forces the fused bar on
  // any platform using the manual dimensions; `'off'` disables it entirely.
  notchMode: 'auto',
  notchWidth: 200,
  notchHeight: 32,
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

// Clamp a manual notch dimension to a sane range so a typo can't push the bar
// off-screen or collapse it to nothing.
function notchDim(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.round(Math.min(max, Math.max(1, number)));
}

function normalizeSettings(value = {}) {
  const pricing = value.pricing && typeof value.pricing === 'object' ? value.pricing : {};
  return {
    sounds: typeof value.sounds === 'boolean' ? value.sounds : DEFAULT_SETTINGS.sounds,
    autoExpand: typeof value.autoExpand === 'boolean' ? value.autoExpand : DEFAULT_SETTINGS.autoExpand,
    launchAtLogin: typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    motion: ['system', 'full', 'reduced'].includes(value.motion) ? value.motion : DEFAULT_SETTINGS.motion,
    privacyMode: typeof value.privacyMode === 'boolean' ? value.privacyMode : DEFAULT_SETTINGS.privacyMode,
    notchMode: ['auto', 'on', 'off'].includes(value.notchMode) ? value.notchMode : DEFAULT_SETTINGS.notchMode,
    notchWidth: notchDim(value.notchWidth, DEFAULT_SETTINGS.notchWidth, 600),
    notchHeight: notchDim(value.notchHeight, DEFAULT_SETTINGS.notchHeight, 80),
    pricing: {
      inputPerMillion: finiteRate(pricing.inputPerMillion),
      outputPerMillion: finiteRate(pricing.outputPerMillion),
      cacheReadPerMillion: finiteRate(pricing.cacheReadPerMillion),
      cacheCreationPerMillion: finiteRate(pricing.cacheCreationPerMillion),
    },
  };
}

module.exports = { DEFAULT_SETTINGS, normalizeSettings };
