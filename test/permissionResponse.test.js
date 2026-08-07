'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { permissionResponse } = require('../src/core/permissionResponse');

test('allow produces a plain allow decision', () => {
  const resp = JSON.parse(permissionResponse('allow', { toolName: 'Bash' }));
  assert.equal(resp.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(resp.hookSpecificOutput.decision.updatedPermissions, undefined);
});

test('deny produces a deny decision', () => {
  const resp = JSON.parse(permissionResponse('deny', { toolName: 'Bash' }));
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'deny');
});

test('allowAll adds a session rule for non-MCP tools', () => {
  const resp = JSON.parse(permissionResponse('allowAll', { toolName: 'Bash' }));
  const dec = resp.hookSpecificOutput.decision;
  assert.equal(dec.behavior, 'allow');
  assert.equal(dec.updatedPermissions[0].type, 'addRules');
  assert.deepEqual(dec.updatedPermissions[0].rules, [{ toolName: 'Bash', ruleContent: '*' }]);
  assert.equal(dec.updatedPermissions[0].destination, 'session');
});

test('allowAll for MCP tools uses bare tool name', () => {
  const resp = JSON.parse(permissionResponse('allowAll', { toolName: 'mcp__server__read' }));
  const rules = resp.hookSpecificOutput.decision.updatedPermissions[0].rules;
  assert.deepEqual(rules, [{ toolName: 'mcp__server__read' }]);
});
