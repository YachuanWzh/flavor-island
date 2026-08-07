'use strict';

// Pure parts of the pixel mascot: scene routing + keyframe interpolation.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sceneForState, lerpKeyframes } = require('../src/renderer/mascot.js');

test('scene routing follows the pill mascot state', () => {
  assert.equal(sceneForState('idle'), 'sleep');
  assert.equal(sceneForState(undefined), 'sleep');
  assert.equal(sceneForState('running'), 'work');
  assert.equal(sceneForState('processing'), 'work');
  assert.equal(sceneForState('waiting'), 'alert');
});

test('lerp interpolates between keyframes', () => {
  const kf = [[0, 0], [0.5, -10], [1, 0]];
  assert.equal(lerpKeyframes(kf, 0), 0);
  assert.equal(lerpKeyframes(kf, 0.25), -5);
  assert.equal(lerpKeyframes(kf, 0.5), -10);
  assert.equal(lerpKeyframes(kf, 0.75), -5);
});

test('lerp clamps before the first and after the last keyframe', () => {
  const kf = [[0.1, 3], [0.6, 9]];
  assert.equal(lerpKeyframes(kf, -1), 3);
  assert.equal(lerpKeyframes(kf, 0), 3);
  assert.equal(lerpKeyframes(kf, 1), 9);
});
