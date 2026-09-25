'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DESIRED_BEHAVIOR } = require('../src/main/notchStationary');

test('notch window uses the AppKit stationary and ignores-cycle bits', () => {
  // CanJoinAllSpaces (1) | Stationary (16) | IgnoresCycle (64)
  // | FullScreenAuxiliary (256). A previous 269 set Transient/Managed instead.
  assert.equal(DESIRED_BEHAVIOR, 337);
});
