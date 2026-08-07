'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppState } = require('../src/main/appState');
const { Status } = require('../src/core/sessionStore');

function evt(name, overrides = {}) {
  return {
    eventName: name,
    sessionId: 's1',
    rawJSON: {},
    ...overrides,
  };
}

test('handleEvent routes to reducer and notifies subscribers', () => {
  const state = createAppState();
  let notified = 0;
  state.subscribe(() => { notified += 1; });

  state.handleEvent(evt('SessionStart'));
  state.handleEvent(evt('UserPromptSubmit', { rawJSON: { prompt: 'hi' } }));
  assert.equal(notified, 2);
  const snap = state.snapshot().sessions.s1;
  assert.equal(snap.status, Status.processing);
});

test('requestPermission blocks until resolved', async () => {
  const state = createAppState();
  const decision = state.requestPermission(evt('PermissionRequest', { toolName: 'Bash' }));
  assert.equal(state.snapshot().sessions.s1.status, Status.waitingApproval);

  // listPending exposes the card
  const pending = state.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'permission');
  assert.equal(pending[0].toolName, 'Bash');

  state.resolvePermission(pending[0].key, 'allow');
  assert.equal(await decision, 'allow');
  assert.equal(state.listPending().length, 0);
});

test('resolvePermission maps unknown behavior to allow', async () => {
  const state = createAppState();
  const decision = state.requestPermission(evt('PermissionRequest', { toolName: 'Bash' }));
  state.resolvePermission(state.listPending()[0].key, 'weird');
  assert.equal(await decision, 'allow');
});

test('allowAll decision passes through', async () => {
  const state = createAppState();
  const decision = state.requestPermission(evt('PermissionRequest', { toolName: 'Bash' }));
  state.resolvePermission(state.listPending()[0].key, 'allowAll');
  assert.equal(await decision, 'allowAll');
});

test('requestAskUserQuestion resolves with allow+answers', async () => {
  const state = createAppState();
  const ev = evt('PermissionRequest', {
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Q1', options: ['a', 'b'] }] },
  });
  const response = state.requestAskUserQuestion(ev);
  assert.equal(state.snapshot().sessions.s1.status, Status.waitingQuestion);

  const pending = state.listPending();
  assert.equal(pending[0].kind, 'askUserQuestion');
  assert.equal(pending[0].questions.length, 1);

  state.resolveAskUserQuestion(pending[0].key, { Q1: 'b' });
  const resp = await response;
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(resp.hookSpecificOutput.decision.updatedInput.answers.Q1, 'b');
});

test('resolveAskUserQuestion carries checkbox state + text into the response', async () => {
  const state = createAppState();
  const ev = evt('PermissionRequest', {
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Q1', options: ['a', 'b'] }] },
  });
  const response = state.requestAskUserQuestion(ev);
  state.resolveAskUserQuestion(
    state.listPending()[0].key,
    { Q1: 'custom answer' },
    { Q1: { checked: true, text: 'custom answer' } }
  );
  const resp = await response;
  const updated = resp.hookSpecificOutput.decision.updatedInput;
  assert.equal(updated.answers.Q1, 'custom answer');
  assert.deepEqual(updated.answerDetails.Q1, { checked: true, text: 'custom answer' });
});

test('empty AskUserQuestion auto-allows without pending', async () => {
  const state = createAppState();
  const ev = evt('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: {} });
  const response = state.requestAskUserQuestion(ev);
  const resp = await response;
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(state.listPending().length, 0);
});

test('skipAskUserQuestion denies', async () => {
  const state = createAppState();
  const ev = evt('PermissionRequest', {
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Q1' }] },
  });
  const response = state.requestAskUserQuestion(ev);
  state.skipAskUserQuestion(state.listPending()[0].key);
  const resp = await response;
  assert.equal(resp.hookSpecificOutput.decision.behavior, 'deny');
});

test('SessionEnd denies pending permissions for that session', async () => {
  const state = createAppState();
  const decision = state.requestPermission(evt('PermissionRequest', { toolName: 'Bash' }));
  state.handleEvent(evt('SessionEnd'));
  assert.equal(await decision, 'deny');
  assert.equal(state.listPending().length, 0);
});

test('cleanupIdle drops idle sessions after maxIdleMs', () => {
  const state = createAppState();
  state.handleEvent(evt('SessionStart'));
  assert.equal(Object.keys(state.snapshot().sessions).length, 1);
  state.cleanupIdle(1000, Date.now() + 5000);
  assert.equal(Object.keys(state.snapshot().sessions).length, 0);
});

test('question kind resolves with answer', async () => {
  const state = createAppState();
  const ev = evt('Notification', { rawJSON: { question: 'Continue?' } });
  const response = state.requestQuestion(ev);
  assert.equal(state.snapshot().sessions.s1.status, Status.waitingQuestion);
  state.resolveQuestion(state.listPending()[0].key, { answer: 'yes' });
  assert.deepEqual(await response, { answer: 'yes' });
});

test('duplicate PermissionRequest while pending shares the same card', async () => {
  // Both the baked-in codeisland plugin and the global flavor-island plugin
  // relay the same hook event -> one card, both callers get the same decision.
  const state = createAppState();
  const make = () => evt('PermissionRequest', {
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    toolDescription: 'npm test',
  });
  const first = state.requestPermission(make());
  const second = state.requestPermission(make());
  assert.equal(state.listPending().length, 1);

  state.resolvePermission(state.listPending()[0].key, 'allow');
  assert.equal(await first, 'allow');
  assert.equal(await second, 'allow');
});

test('back-to-back duplicate PermissionRequest replays the last decision', async () => {
  // The second plugin's relay runs sequentially and arrives after the user has
  // already decided the first — it must not spawn a fresh card.
  const state = createAppState();
  const make = () => evt('PermissionRequest', {
    toolName: 'Bash',
    toolInput: { command: 'npm test' },
    toolDescription: 'npm test',
  });
  const first = state.requestPermission(make());
  state.resolvePermission(state.listPending()[0].key, 'deny');
  assert.equal(await first, 'deny');

  const second = state.requestPermission(make());
  assert.equal(state.listPending().length, 0);
  assert.equal(await second, 'deny');
});

test('distinct PermissionRequests are not deduplicated', async () => {
  const state = createAppState();
  const a = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'npm test' },
  }));
  const b = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'git status' },
  }));
  assert.equal(state.listPending().length, 2);
  const keys = state.listPending().map((p) => p.key);
  state.resolvePermission(keys[0], 'allow');
  state.resolvePermission(keys[1], 'deny');
  assert.equal(await a, 'allow');
  assert.equal(await b, 'deny');
});
