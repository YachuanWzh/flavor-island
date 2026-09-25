'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clampWindowHeight, computeWindowBounds, computeNotchMetrics, computeNotchWindowBounds, computeNotchContentWidth } = require('../src/core/windowLayout');

test('clampWindowHeight clamps to available minus margin', () => {
  assert.equal(clampWindowHeight(100, 800, { topMargin: 6 }), 100);
  assert.equal(clampWindowHeight(900, 800, { topMargin: 6 }), 794);
  assert.equal(clampWindowHeight(5, 800, { min: 20 }), 20);
});

test('computeWindowBounds centers horizontally by default', () => {
  const b = computeWindowBounds(56, { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, width: 420, topMargin: 6 });
  assert.deepEqual(b, { x: 750, y: 6, width: 420, height: 56 });
});

test('computeWindowBounds keeps user position and re-clamps height', () => {
  const b = computeWindowBounds(600, {
    workArea: { x: 0, y: 0, width: 1920, height: 500 },
    width: 420,
    topMargin: 6,
    min: 1,
    userPosition: { x: 100, y: 200 },
  });
  assert.equal(b.x, 100);
  assert.equal(b.y, 200);
  assert.equal(b.height, 300); // clamped to the space below the dragged y
});

test('computeWindowBounds leaves in-range height untouched', () => {
  const b = computeWindowBounds(300, {
    workArea: { x: 0, y: 0, width: 1920, height: 500 },
    width: 420,
    topMargin: 6,
    min: 1,
    userPosition: { x: 100, y: 200 },
  });
  assert.equal(b.height, 300);
});

// Mirrors CodeIsland's ScreenDetector: on a notch display the window must sit
// at the very top of the *physical* screen (display bounds, not the work area,
// which starts below the menu bar and leaves the island hanging under the
// notch), sized to the notch itself. Non-Mac and no-notch Macs keep the pill.
test('computeNotchMetrics detects a notch from the top inset (macOS)', () => {
  // MacBook Pro 14": 1512x982 logical, menu bar + notch occupy ~38pt.
  const m = computeNotchMetrics({
    isMac: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 },
  });
  assert.equal(m.hasNotch, true);
  assert.equal(m.notchHeight, 38);
  // Notch width follows CodeIsland's fake-notch rule: 14% of screen width,
  // clamped into [160, 240].
  assert.equal(m.notchWidth, 212);
});

test('computeNotchMetrics treats a plain menu bar as no notch', () => {
  const m = computeNotchMetrics({
    isMac: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 25, width: 1920, height: 1055 },
  });
  assert.equal(m.hasNotch, false);
  assert.equal(m.notchHeight, 0);
  assert.equal(m.notchWidth, 0);
});

test('computeNotchMetrics is off on Windows without a manual notch', () => {
  const m = computeNotchMetrics({
    isMac: false,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    workArea: { x: 0, y: 40, width: 2560, height: 1400 },
  });
  assert.equal(m.hasNotch, false);
  assert.equal(m.notchHeight, 0);
});

test('computeNotchMetrics honors a manual notch on Windows (notch-screen fusion)', () => {
  const m = computeNotchMetrics({
    isMac: false,
    bounds: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 0, y: 0, width: 1920, height: 1160 },
    manual: { mode: 'on', notchWidth: 180, notchHeight: 28 },
  });
  assert.equal(m.hasNotch, true);
  assert.equal(m.notchWidth, 180);
  assert.equal(m.notchHeight, 28);
});

test('computeNotchMetrics off mode disables even macOS auto-detection', () => {
  const m = computeNotchMetrics({
    isMac: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 },
    manual: { mode: 'off' },
  });
  assert.equal(m.hasNotch, false);
  assert.equal(m.notchHeight, 0);
});

test('computeNotchMetrics auto mode falls back to macOS detection', () => {
  const m = computeNotchMetrics({
    isMac: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 },
    manual: { mode: 'auto' },
  });
  assert.equal(m.hasNotch, true);
  assert.equal(m.notchHeight, 38);
});

test('notch width preserves the measured brand slot past 580px', () => {
  assert.equal(computeNotchContentWidth(212, null), 332);
  assert.equal(computeNotchContentWidth(212, 586), 586);
});

test('notch window bounds pin the window to the physical screen top', () => {
  const b = computeNotchWindowBounds(56, {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    width: 212 + 2 * 60,
  });
  assert.equal(b.y, 0); // top of the physical display, behind the notch
  assert.equal(b.width, 332);
  assert.equal(b.x, Math.round((1512 - 332) / 2));
});

test('notch window bounds clamp an oversized width to the screen', () => {
  const b = computeNotchWindowBounds(400, {
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    width: 900,
  });
  assert.equal(b.width, 800);
  assert.equal(b.x, 0);
});
