'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reduceEvent, newSession, Status } = require('../src/core/sessionStore');

function evt(name, overrides = {}) {
  return {
    eventName: name,
    sessionId: 's1',
    rawJSON: {},
    ...overrides,
  };
}

test('newSession starts idle with fresh arrays', () => {
  const s = newSession();
  assert.equal(s.status, Status.idle);
  assert.deepEqual(s.history, []);
  assert.deepEqual(s.recentMessages, []);
  assert.equal(typeof s.startTime, 'number');
});

test('SessionStart creates a session and applies metadata', () => {
  const sessions = {};
  reduceEvent(sessions, evt('SessionStart', {
    rawJSON: { _source: 'flavor-code', cwd: 'C:\\proj', model: 'deepseek-v3', _ppid: 42 },
  }));
  const s = sessions.s1;
  assert.equal(s.source, 'flavor-code');
  assert.equal(s.cwd, 'C:\\proj');
  assert.equal(s.model, 'deepseek-v3');
  assert.equal(s.cliPid, 42);
});

test('SessionStart stores local control metadata without exposing it to tools', () => {
  const sessions = {};
  reduceEvent(sessions, evt('SessionStart', {
    rawJSON: {
      island_control_endpoint: '\\\\.\\pipe\\session', island_control_token: 'token',
      island_control_capabilities: ['abort', 'steer'],
    },
  }));
  assert.equal(sessions.s1.controlToken, 'token');
  assert.deepEqual(sessions.s1.controlCapabilities, ['abort', 'steer']);
});

test('AfterModelCall aggregates usage and Stop records deliverables', () => {
  const sessions = {};
  reduceEvent(sessions, evt('SessionStart'));
  reduceEvent(sessions, evt('AfterModelCall', { rawJSON: {
    input_tokens: 100, output_tokens: 20, cache_read_tokens: 30,
    cache_creation_tokens: 4, model_duration_ms: 750, providerError: false,
  } }));
  reduceEvent(sessions, evt('Stop', { rawJSON: {
    summary: 'Done', deliverables: [{ path: 'src/a.js', operation: 'update', added: 2, removed: 1 }],
  } }));
  assert.deepEqual(sessions.s1.usage, {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 30,
    cacheCreationTokens: 4, durationMs: 750, calls: 1,
  });
  assert.equal(sessions.s1.lastAssistantMessage, 'Done');
  assert.equal(sessions.s1.deliverables[0].path, 'src/a.js');
});

test('UserPromptSubmit sets processing and records prompt', () => {
  const sessions = {};
  reduceEvent(sessions, evt('UserPromptSubmit', { rawJSON: { prompt: 'hello' } }));
  const s = sessions.s1;
  assert.equal(s.status, Status.processing);
  assert.equal(s.lastUserPrompt, 'hello');
  assert.equal(s.recentMessages.length, 1);
  assert.equal(s.recentMessages[0].isUser, true);
});

test('PreToolUse sets running + currentTool; PostToolUse records and returns to processing', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreToolUse', { toolName: 'Bash', toolDescription: 'npm test' }));
  const s = sessions.s1;
  assert.equal(s.status, Status.running);
  assert.equal(s.currentTool, 'Bash');
  assert.equal(s.toolDescription, 'npm test');

  reduceEvent(sessions, evt('PostToolUse'));
  assert.equal(s.status, Status.processing);
  assert.equal(s.currentTool, null);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].tool, 'Bash');
  assert.equal(s.history[0].success, true);
});

test('parallel tools remain running until each matching call finishes', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreToolUse', { toolUseId: 'read-1', toolName: 'Read', toolDescription: 'a.js' }));
  reduceEvent(sessions, evt('PreToolUse', { toolUseId: 'grep-1', toolName: 'Grep', toolDescription: 'needle' }));

  reduceEvent(sessions, evt('PostToolUse', { toolUseId: 'read-1', toolName: 'Read' }));
  assert.equal(sessions.s1.status, Status.running);
  assert.equal(sessions.s1.currentTool, 'Grep');
  assert.equal(sessions.s1.history.at(-1).tool, 'Read');

  reduceEvent(sessions, evt('PostToolUse', { toolUseId: 'grep-1', toolName: 'Grep' }));
  assert.equal(sessions.s1.status, Status.processing);
  assert.equal(sessions.s1.currentTool, null);
  assert.deepEqual(sessions.s1.history.map((item) => item.tool), ['Read', 'Grep']);
});

test('PostToolUseFailure records failure', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreToolUse', { toolName: 'Edit' }));
  reduceEvent(sessions, evt('PostToolUseFailure'));
  assert.equal(sessions.s1.history[0].success, false);
});

test('waitingApproval suppresses tool state changes', () => {
  const sessions = {};
  const appStateLike = {
    handleEvent(e) { reduceEvent(sessions, e); },
    requestPermission(e) {
      const s = sessions[e.sessionId] || (sessions[e.sessionId] = newSession());
      s.status = Status.waitingApproval;
    },
  };
  appStateLike.handleEvent(evt('PreToolUse', { toolName: 'Bash' }));
  appStateLike.requestPermission(evt('PermissionRequest', { toolName: 'Bash' }));
  // While waiting, new tool events must not clobber the waiting state.
  appStateLike.handleEvent(evt('PreToolUse', { toolName: 'Read' }));
  assert.equal(sessions.s1.status, Status.waitingApproval);
  assert.equal(sessions.s1.currentTool, 'Bash');
});

test('Stop sets idle and enqueues completion effect', () => {
  const sessions = {};
  reduceEvent(sessions, evt('UserPromptSubmit', { rawJSON: { prompt: 'q' } }));
  const { effects } = reduceEvent(sessions, evt('Stop', { rawJSON: { last_assistant_message: 'done' } }));
  const s = sessions.s1;
  assert.equal(s.status, Status.idle);
  assert.equal(s.lastAssistantMessage, 'done');
  assert.ok(effects.some((e) => e.type === 'enqueueCompletion'));
});

test('Stop with user reason marks interrupted', () => {
  const sessions = {};
  const { effects } = reduceEvent(sessions, evt('Stop', { rawJSON: { stop_reason: 'user' } }));
  assert.equal(sessions.s1.interrupted, true);
  assert.ok(effects.some((e) => e.type === 'enqueueCompletion'));
});

test('SessionEnd emits removeSession effect (deletion is applied by appState)', () => {
  const sessions = {};
  reduceEvent(sessions, evt('SessionStart'));
  const { effects } = reduceEvent(sessions, evt('SessionEnd'));
  assert.deepEqual(effects, [{ type: 'removeSession', sessionId: 's1' }]);
  // Pure reducer leaves the map intact; the appState layer applies the effect.
  assert.ok(sessions.s1);
});

test('Notification sets toolDescription', () => {
  const sessions = {};
  reduceEvent(sessions, evt('Notification', { rawJSON: { message: 'heads up' } }));
  assert.equal(sessions.s1.toolDescription, 'heads up');
});

test('SubagentStart/Stop transition running state', () => {
  const sessions = {};
  reduceEvent(sessions, evt('SubagentStart', { rawJSON: { agent_type: 'general-purpose' } }));
  const s = sessions.s1;
  assert.equal(s.status, Status.running);
  assert.equal(s.currentTool, 'Agent');
  assert.equal(s.toolDescription, 'general-purpose');
  reduceEvent(sessions, evt('SubagentStop'));
  assert.equal(s.status, Status.processing);
  assert.equal(s.currentTool, null);
});

test('newSession initializes tool output/error tracking fields', () => {
  const s = newSession();
  assert.equal(s.lastToolOutput, null);
  assert.equal(s.lastToolError, null);
  assert.equal(s.failureCount, 0);
  assert.equal(s.lastModelError, null);
});

test('PostToolUse stores lastToolOutput from rawJSON.tool_output and clears lastToolError', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreToolUse', { toolName: 'Bash' }));
  reduceEvent(sessions, evt('PostToolUseFailure', { rawJSON: { tool_error: 'boom' } }));
  reduceEvent(sessions, evt('PostToolUse', { rawJSON: { tool_output: 'all good' } }));
  const s = sessions.s1;
  assert.equal(s.lastToolOutput, 'all good');
  assert.equal(s.lastToolError, null);
});

test('PostToolUseFailure sets lastToolError and increments failureCount', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreToolUse', { toolName: 'Edit' }));
  reduceEvent(sessions, evt('PostToolUseFailure', { rawJSON: { tool_error: 'boom' } }));
  reduceEvent(sessions, evt('PostToolUseFailure', { rawJSON: { tool_error: 'bang' } }));
  const s = sessions.s1;
  assert.equal(s.lastToolError, 'bang');
  assert.equal(s.failureCount, 2);
});

test('BeforeModelCall sets processing status, model description, and records model', () => {
  const sessions = {};
  reduceEvent(sessions, evt('BeforeModelCall', { rawJSON: { modelId: 'deepseek-v4' } }));
  const s = sessions.s1;
  assert.equal(s.status, Status.processing);
  assert.equal(s.currentTool, null);
  assert.equal(s.toolDescription, 'Model · deepseek-v4');
  assert.equal(s.model, 'deepseek-v4');
});

test('BeforeModelCall reads the bridge-shaped model key', () => {
  const sessions = {};
  // The bridge flattens payload.modelId to top-level `model`; the reducer must
  // accept that shape too (direct modelId still works for other CLIs).
  reduceEvent(sessions, evt('BeforeModelCall', { rawJSON: { model: 'deepseek-v4' } }));
  const s = sessions.s1;
  assert.equal(s.status, Status.processing);
  assert.equal(s.toolDescription, 'Model · deepseek-v4');
  assert.equal(s.model, 'deepseek-v4');
});

test('AfterModelCall clears toolDescription; providerError records lastModelError', () => {
  const sessions = {};
  reduceEvent(sessions, evt('BeforeModelCall', { rawJSON: { modelId: 'deepseek-v4' } }));
  reduceEvent(sessions, evt('AfterModelCall', {
    rawJSON: { providerError: true, errorMessage: 'rate limited' },
  }));
  const s = sessions.s1;
  assert.equal(s.status, Status.processing);
  assert.equal(s.currentTool, null);
  assert.equal(s.toolDescription, null);
  assert.equal(s.lastModelError, 'rate limited');
});

test('AfterModelCall without provider error leaves lastModelError untouched', () => {
  const sessions = {};
  reduceEvent(sessions, evt('AfterModelCall', { rawJSON: { providerError: false, errorMessage: 'nope' } }));
  assert.equal(sessions.s1.lastModelError, null);
});

test('BeforePlan sets planning status; AfterPlan returns to processing', () => {
  const sessions = {};
  reduceEvent(sessions, evt('BeforePlan'));
  const s = sessions.s1;
  assert.equal(s.status, Status.planning);
  assert.equal(s.currentTool, null);
  assert.equal(s.toolDescription, 'Planning…');
  reduceEvent(sessions, evt('AfterPlan'));
  assert.equal(s.status, Status.processing);
  assert.equal(s.currentTool, null);
  assert.equal(s.toolDescription, null);
});

test('PostCompact clears the compacting description', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreCompact'));
  assert.equal(sessions.s1.toolDescription, 'Compacting context…');
  reduceEvent(sessions, evt('PostCompact'));
  const s = sessions.s1;
  assert.equal(s.status, Status.processing);
  assert.equal(s.currentTool, null);
  assert.equal(s.toolDescription, null);
});

test('Stop with stop_reason cancelled marks interrupted (regression for the bug)', () => {
  const sessions = {};
  reduceEvent(sessions, evt('Stop', { rawJSON: { stop_reason: 'cancelled' } }));
  assert.equal(sessions.s1.interrupted, true);
});

test('waitingApproval suppresses BeforeModelCall/BeforePlan status changes', () => {
  const sessions = {};
  reduceEvent(sessions, evt('PreToolUse', { toolName: 'Bash', toolDescription: 'npm test' }));
  sessions.s1.status = Status.waitingApproval;
  reduceEvent(sessions, evt('BeforeModelCall', { rawJSON: { modelId: 'deepseek-v4' } }));
  assert.equal(sessions.s1.status, Status.waitingApproval);
  assert.equal(sessions.s1.toolDescription, 'npm test');
  reduceEvent(sessions, evt('BeforePlan'));
  assert.equal(sessions.s1.status, Status.waitingApproval);
  assert.equal(sessions.s1.toolDescription, 'npm test');
});

test('task snapshot notifications are stored and Stop clears them', () => {
  const sessions = {};
  const snapshot = { plan: { tasks: [{ id: 't1', status: 'in_progress' }] }, subagents: { states: {} } };
  reduceEvent(sessions, evt('Notification', {
    rawJSON: { notification_kind: 'task_snapshot', task_snapshot: snapshot },
  }));
  assert.deepEqual(sessions.s1.taskSnapshot, snapshot);
  reduceEvent(sessions, evt('Stop'));
  assert.equal(sessions.s1.taskSnapshot, null);
});

test('LoopEnd stores verification outcome and a new prompt clears it', () => {
  const sessions = {};
  reduceEvent(sessions, evt('LoopEnd', {
    rawJSON: {
      loop_id: 'loop-1', loop_outcome: 'failed', loop_reason: 'tests failed',
      loop_verification: { passed: false, summary: '1 test failed' },
    },
  }));
  assert.deepEqual(sessions.s1.loopOutcome, {
    loopId: 'loop-1', outcome: 'failed', reason: 'tests failed',
    verification: { passed: false, summary: '1 test failed' },
  });
  reduceEvent(sessions, evt('UserPromptSubmit', { rawJSON: { prompt: 'try again' } }));
  assert.equal(sessions.s1.loopOutcome, null);
});

test('evolve telemetry LoopEnd does not create a /go result card', () => {
  const sessions = {};
  reduceEvent(sessions, evt('LoopEnd', { rawJSON: { status: 'completed', iterations: 2 } }));
  assert.equal(sessions.s1.loopOutcome, null);
});
