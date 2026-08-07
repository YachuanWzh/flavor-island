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
