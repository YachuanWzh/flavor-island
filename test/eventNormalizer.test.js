'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../src/core/eventNormalizer');

test('PascalCase names pass through unchanged', () => {
  assert.equal(normalize('SessionStart'), 'SessionStart');
  assert.equal(normalize('PreToolUse'), 'PreToolUse');
  assert.equal(normalize('PermissionRequest'), 'PermissionRequest');
  assert.equal(normalize('Stop'), 'Stop');
});

test('camelCase and snake_case aliases normalize', () => {
  assert.equal(normalize('beforeSubmitPrompt'), 'UserPromptSubmit');
  assert.equal(normalize('session_start'), 'SessionStart');
  assert.equal(normalize('permission_request'), 'PermissionRequest');
  assert.equal(normalize('pre_tool_use'), 'PreToolUse');
});

test('non-string input is returned as-is', () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize(undefined), undefined);
  assert.equal(normalize(42), 42);
});
