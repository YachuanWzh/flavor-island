'use strict';

// ESM test for the flavor-code → island bridge transform. Kept as .mjs to
// match the ESM plugin sources it exercises (bridge.mjs / eventTransform.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { transformEvent } from '../src/plugin/eventTransform.mjs';

function evt(type, payload = {}) {
  return { type, payload };
}

test('baseline: maps tool, agent, and flattens string input values', () => {
  const out = transformEvent(evt('PreToolUse', {
    tool: 'Bash',
    agent: 'main',
    input: { command: 'npm test', description: 'Run tests' },
  }));
  assert.equal(out.hook_event_name, 'PreToolUse');
  assert.equal(out.tool_name, 'Bash');
  assert.equal(out.agent_type, 'main');
  assert.deepEqual(out.tool_input, { command: 'npm test', description: 'Run tests' });
  // String values from input are flattened to the top level.
  assert.equal(out.command, 'npm test');
  assert.equal(out.description, 'Run tests');
});

test('baseline: maps reason, modelId, workspace, prompt, outcome', () => {
  const out = transformEvent(evt('Stop', {
    reason: 'wrapped up',
    modelId: 'deepseek-v4-flash',
    workspace: 'C:\\proj',
    prompt: 'hello',
    outcome: 'cancelled',
  }));
  assert.equal(out.message, 'wrapped up');
  assert.equal(out.model, 'deepseek-v4-flash');
  assert.equal(out.cwd, 'C:\\proj');
  assert.equal(out.prompt, 'hello');
  assert.equal(out.stop_reason, 'cancelled');
});

test('baseline: description fills message only when message is absent', () => {
  const withReason = transformEvent(evt('SubagentStart', {
    reason: 'first',
    description: 'second',
  }));
  assert.equal(withReason.message, 'first');

  const withDescription = transformEvent(evt('SubagentStart', {
    description: 'planning agent',
  }));
  assert.equal(withDescription.message, 'planning agent');
});

test('baseline: iteration overrides message', () => {
  const out = transformEvent(evt('Notification', {
    message: 'stale',
    iteration: 3,
  }));
  assert.equal(out.message, 'iteration 3');
});

test('baseline: session identity metadata is preserved', () => {
  const out = transformEvent(evt('SessionStart', { workspace: 'C:\\proj' }));
  assert.match(out.session_id, /^flavor-/);
  assert.equal(out._source, 'flavor-code');
  assert.equal(typeof out._ppid, 'number');
  assert.ok(out._ppid > 0);
});

test('protocol v2 preserves stable session, event, and tool-call identity', () => {
  const out = transformEvent(evt('PermissionRequest', {
    protocolVersion: 2,
    sessionId: 'session-stable',
    eventId: 'event-7',
    sequence: 7,
    timestamp: '2026-08-26T00:00:00.000Z',
    toolCallId: 'call-2',
    tool: 'Shell',
    reason: 'Command writes outside the workspace',
    toolCategory: 'shell',
    allowAlways: false,
  }));
  assert.equal(out.session_id, 'session-stable');
  assert.equal(out.event_id, 'event-7');
  assert.equal(out.event_sequence, 7);
  assert.equal(out.event_timestamp, '2026-08-26T00:00:00.000Z');
  assert.equal(out.tool_use_id, 'call-2');
  assert.equal(out.approval_reason, 'Command writes outside the workspace');
  assert.equal(out.tool_category, 'shell');
  assert.equal(out.allow_always, false);
});

test('PostToolUse: output string passes through', () => {
  const out = transformEvent(evt('PostToolUse', {
    tool: 'Bash',
    output: 'all tests passed',
  }));
  assert.equal(out.tool_output, 'all tests passed');
});

test('PostToolUse: output object is JSON-stringified', () => {
  const out = transformEvent(evt('PostToolUse', {
    tool: 'Glob',
    output: { matches: ['a.js', 'b.js'] },
  }));
  assert.equal(out.tool_output, JSON.stringify({ matches: ['a.js', 'b.js'] }));
});

test('PostToolUse: output longer than 2000 chars is truncated to 2000', () => {
  const long = 'x'.repeat(5000);
  const out = transformEvent(evt('PostToolUse', { tool: 'Bash', output: long }));
  assert.equal(out.tool_output.length, 2000);
  assert.equal(out.tool_output, long.slice(0, 2000));
});

test('PostToolUse: empty output is omitted', () => {
  const out = transformEvent(evt('PostToolUse', { tool: 'Bash', output: '' }));
  assert.ok(!('tool_output' in out));
});

test('PostToolUseFailure: error.message maps to tool_error', () => {
  const out = transformEvent(evt('PostToolUseFailure', {
    tool: 'Edit',
    error: { code: 'permission_denied', message: 'no access' },
  }));
  assert.equal(out.tool_error, 'no access');
});

test('PostToolUseFailure: error.message longer than 300 chars is truncated to 300', () => {
  const long = 'e'.repeat(800);
  const out = transformEvent(evt('PostToolUseFailure', {
    tool: 'Bash',
    error: { code: 'tool_error', message: long },
  }));
  assert.equal(out.tool_error.length, 300);
  assert.equal(out.tool_error, long.slice(0, 300));
});

test('missing output/error leaves those keys absent', () => {
  const out = transformEvent(evt('PreToolUse', { tool: 'Read' }));
  assert.ok(!('tool_output' in out));
  assert.ok(!('tool_error' in out));
});

test('AfterModelCall: providerError and errorMessage pass through', () => {
  const out = transformEvent(evt('AfterModelCall', {
    modelId: 'deepseek-v4',
    providerError: true,
    errorMessage: 'rate limited',
  }));
  assert.equal(out.providerError, true);
  assert.equal(out.errorMessage, 'rate limited');
});

test('AfterModelCall: absent provider fields leave keys absent', () => {
  const out = transformEvent(evt('AfterModelCall', { modelId: 'deepseek-v4' }));
  assert.ok(!('providerError' in out));
  assert.ok(!('errorMessage' in out));
});

test('task snapshot notification keeps the nested task contract', () => {
  const snapshot = {
    plan: { tasks: [{ id: 't1', subject: 'Cache', activeForm: 'Implementing cache', status: 'in_progress', dependencies: [] }] },
    subagents: { states: {} },
    foregroundTaskId: 't1',
  };
  const out = transformEvent(evt('Notification', { kind: 'task_snapshot', taskSnapshot: snapshot }));
  assert.equal(out.notification_kind, 'task_snapshot');
  assert.deepEqual(out.task_snapshot, snapshot);
});

test('LoopEnd maps terminal outcome and verification evidence', () => {
  const out = transformEvent(evt('LoopEnd', {
    loopId: 'loop-1', outcome: 'failed', reason: 'tests failed',
    verification: { passed: false, summary: '1 test failed' },
  }));
  assert.equal(out.loop_id, 'loop-1');
  assert.equal(out.loop_outcome, 'failed');
  assert.equal(out.loop_reason, 'tests failed');
  assert.deepEqual(out.loop_verification, { passed: false, summary: '1 test failed' });
});

test('notification question maps its prompt and choices', () => {
  const options = [{ label: 'Continue', description: 'Keep working' }];
  const out = transformEvent(evt('Notification', { question: 'Continue?', options }));
  assert.equal(out.question, 'Continue?');
  assert.deepEqual(out.question_options, options);
});
