'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clampWindowHeight, computeWindowBounds } = require('../src/core/windowLayout');

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
