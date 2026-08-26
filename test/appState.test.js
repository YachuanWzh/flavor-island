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

test('allowAll is delegated to flavor-code instead of creating a local auto-approval rule', async () => {
  const state = createAppState();
  const first = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'npm test' },
  }));
  state.resolvePermission(state.listPending()[0].key, 'allowAll');
  assert.equal(await first, 'allowAll');

  // If flavor-code sends another request, it needs a new decision. The host
  // normally suppresses this event after safely persisting the category.
  const second = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'git status' },
  }));
  assert.equal(state.listPending().length, 1);
  state.resolvePermission(state.listPending()[0].key, 'allow');
  assert.equal(await second, 'allow');
});

test('permission card exposes host safety metadata and reason', async () => {
  const state = createAppState();
  const decision = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Shell',
    rawJSON: {
      approval_reason: 'Writes outside the workspace',
      tool_category: 'shell',
      allow_always: false,
    },
  }));
  const card = state.listPending()[0];
  assert.equal(card.reason, 'Writes outside the workspace');
  assert.equal(card.toolCategory, 'shell');
  assert.equal(card.allowAlways, false);
  state.resolvePermission(card.key, 'deny');
  await decision;
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

test('duplicate AskUserQuestion relays share one pending card', async () => {
  const state = createAppState();
  const toolInput = { questions: [{ question: 'Q1', options: ['a', 'b'] }] };
  const first = state.requestAskUserQuestion(evt('PermissionRequest', { eventId: 'ask-1', toolName: 'AskUserQuestion', toolInput }));
  // A second plugin tier relays the identical hook event while the card waits.
  const second = state.requestAskUserQuestion(evt('PermissionRequest', { eventId: 'ask-1', toolName: 'AskUserQuestion', toolInput }));
  assert.equal(state.listPending().length, 1);

  state.resolveAskUserQuestion(state.listPending()[0].key, { Q1: 'b' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.hookSpecificOutput.decision.updatedInput.answers.Q1, 'b');
});

test('late AskUserQuestion relay replays the resolved response', async () => {
  const state = createAppState();
  const toolInput = { questions: [{ question: 'Q1', options: ['a', 'b'] }] };
  const first = state.requestAskUserQuestion(evt('PermissionRequest', { eventId: 'ask-1', toolName: 'AskUserQuestion', toolInput }));
  state.resolveAskUserQuestion(state.listPending()[0].key, { Q1: 'a' });
  await first;

  // The second tier's relay runs sequentially, after the first resolved.
  const replay = await state.requestAskUserQuestion(evt('PermissionRequest', { eventId: 'ask-1', toolName: 'AskUserQuestion', toolInput }));
  assert.equal(replay.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(replay.hookSpecificOutput.decision.updatedInput.answers.Q1, 'a');
  assert.equal(state.listPending().length, 0);
});

test('late AskUserQuestion relay replays a skip as deny', async () => {
  const state = createAppState();
  const toolInput = { questions: [{ question: 'Q1', options: ['a', 'b'] }] };
  const first = state.requestAskUserQuestion(evt('PermissionRequest', { eventId: 'ask-2', toolName: 'AskUserQuestion', toolInput }));
  state.skipAskUserQuestion(state.listPending()[0].key);
  await first;

  const replay = await state.requestAskUserQuestion(evt('PermissionRequest', { eventId: 'ask-2', toolName: 'AskUserQuestion', toolInput }));
  assert.equal(replay.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(state.listPending().length, 0);
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
    eventId: 'permission-1',
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

test('legacy identical requests are not replayed after resolution', async () => {
  const state = createAppState();
  const make = () => evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'npm test' }, toolDescription: 'npm test',
  });
  const first = state.requestPermission(make());
  state.resolvePermission(state.listPending()[0].key, 'allow');
  await first;

  const second = state.requestPermission(make());
  assert.equal(state.listPending().length, 1);
  state.resolvePermission(state.listPending()[0].key, 'deny');
  assert.equal(await second, 'deny');
});

test('back-to-back duplicate PermissionRequest replays the last decision', async () => {
  // The second plugin's relay runs sequentially and arrives after the user has
  // already decided the first — it must not spawn a fresh card.
  const state = createAppState();
  const make = () => evt('PermissionRequest', {
    eventId: 'permission-2',
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

// --- Tool-display smoothing -------------------------------------------------
// Fast tool calls must not flash through the pill: reveal is delayed, and a
// revealed chip stays for a minimum hold. These tests drive the scheduler
// with an injectable fake clock instead of real timers.

function createClock() {
  let t = 0;
  const timers = [];
  const now = () => t;
  const delay = (fn, ms) => {
    const timer = { at: t + ms, fn, cancelled: false, fired: false, clear() { this.cancelled = true; } };
    timers.push(timer);
    return timer;
  };
  const advance = (ms) => {
    const target = t + ms;
    for (;;) {
      const next = timers
        .filter((x) => !x.cancelled && !x.fired && x.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      t = next.at;
      next.fired = true;
      next.fn();
    }
    t = target;
  };
  return { now, delay, advance };
}

function createStateWithClock() {
  const clock = createClock();
  const state = createAppState({ now: clock.now, delay: clock.delay });
  state.handleEvent(evt('SessionStart'));
  return { state, clock };
}

test('fast tool never surfaces on the pill but still lands in history', () => {
  const { state, clock } = createStateWithClock();
  state.handleEvent(evt('PreToolUse', { toolName: 'Read', toolDescription: 'main.js' }));
  const s = state.snapshot().sessions.s1;
  // Reducer set running, but the scheduler keeps the tool off the session
  // until the reveal delay elapses.
  assert.equal(s.currentTool, null);

  clock.advance(100); // finishes well inside the 300ms reveal delay
  state.handleEvent(evt('PostToolUse'));
  assert.equal(s.currentTool, null);
  clock.advance(2000); // no zombie reveal later
  assert.equal(s.currentTool, null);

  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].tool, 'Read');
  assert.equal(s.history[0].success, true);
});

test('slow tool reveals after the delay and holds for the minimum time', () => {
  const { state, clock } = createStateWithClock();
  state.handleEvent(evt('PreToolUse', { toolName: 'Bash', toolDescription: 'npm test' }));
  const s = state.snapshot().sessions.s1;

  clock.advance(299);
  assert.equal(s.currentTool, null);
  clock.advance(1);
  assert.equal(s.currentTool, 'Bash');
  assert.equal(s.status, Status.running);

  // Finishes at 500ms — the chip stays until 800ms after it revealed (t1100).
  clock.advance(200);
  state.handleEvent(evt('PostToolUse'));
  assert.equal(s.currentTool, 'Bash');
  clock.advance(599);
  assert.equal(s.currentTool, 'Bash');
  clock.advance(1);
  assert.equal(s.currentTool, null);
  assert.equal(s.status, Status.processing);
  assert.equal(s.history.length, 1);
});

test('tool running past the min hold drops immediately on completion', () => {
  const { state, clock } = createStateWithClock();
  state.handleEvent(evt('PreToolUse', { toolName: 'Bash' }));
  const s = state.snapshot().sessions.s1;
  clock.advance(300); // revealed
  clock.advance(900); // held 900ms total
  state.handleEvent(evt('PostToolUse'));
  assert.equal(s.currentTool, null);
});

test('rapid tool relay never strobes: successor waits out its own reveal', () => {
  const { state, clock } = createStateWithClock();
  const s = state.snapshot().sessions.s1;

  state.handleEvent(evt('PreToolUse', { toolName: 'Bash', toolDescription: 'npm test' }));
  clock.advance(300); // Bash revealed
  assert.equal(s.currentTool, 'Bash');

  // Bash finishes quickly; Read starts right after while the chip is held.
  clock.advance(100);
  state.handleEvent(evt('PostToolUse'));
  state.handleEvent(evt('PreToolUse', { toolName: 'Read', toolDescription: 'main.js' }));
  assert.equal(s.currentTool, 'Bash'); // chip never collapsed in between

  // Read also finishes before the hold expires — it must never flash.
  clock.advance(100);
  state.handleEvent(evt('PostToolUse'));
  clock.advance(1000);
  assert.equal(s.currentTool, null);
  assert.equal(s.status, Status.processing);
  // Both calls are recorded even though neither flickered on the pill.
  assert.deepEqual(s.history.map((h) => h.tool), ['Bash', 'Read']);
});

test('parallel tool completion only clears its matching display activity', () => {
  const { state, clock } = createStateWithClock();
  const s = state.snapshot().sessions.s1;
  state.handleEvent(evt('PreToolUse', {
    toolUseId: 'read-1', toolName: 'Read', toolDescription: 'a.js',
  }));
  state.handleEvent(evt('PreToolUse', {
    toolUseId: 'grep-1', toolName: 'Grep', toolDescription: 'needle',
  }));

  state.handleEvent(evt('PostToolUse', { toolUseId: 'read-1', toolName: 'Read' }));
  clock.advance(300);
  assert.equal(s.currentTool, 'Grep');
  assert.equal(s.toolDescription, 'needle');
});

test('queued tool reveals only after the held chip drops', () => {
  const { state, clock } = createStateWithClock();
  const s = state.snapshot().sessions.s1;

  state.handleEvent(evt('PreToolUse', { toolName: 'Bash' }));
  clock.advance(300); // Bash revealed
  clock.advance(100);
  state.handleEvent(evt('PostToolUse'));
  state.handleEvent(evt('PreToolUse', { toolName: 'Grep', toolDescription: 'TODO' }));
  // Chip still held; Grep waits.
  assert.equal(s.currentTool, 'Bash');

  clock.advance(400); // t800 — chip still held (hold runs to t1100)
  assert.equal(s.currentTool, 'Bash');
  clock.advance(299);
  assert.equal(s.currentTool, 'Bash');
  clock.advance(1); // hold expires 800ms after reveal (t1100)
  assert.equal(s.currentTool, null);
  clock.advance(299);
  assert.equal(s.currentTool, null);
  clock.advance(1); // Grep's own 300ms reveal delay (t1400)
  assert.equal(s.currentTool, 'Grep');
});

test('Stop discards a half-revealed tool instead of resurrecting it', () => {
  const { state, clock } = createStateWithClock();
  const s = state.snapshot().sessions.s1;
  state.handleEvent(evt('PreToolUse', { toolName: 'Bash' }));
  clock.advance(100);
  state.handleEvent(evt('Stop'));
  clock.advance(2000);
  assert.equal(s.currentTool, null);
  assert.equal(s.status, Status.idle);
});

test('SessionEnd clears display timers with the session', () => {
  const { state, clock } = createStateWithClock();
  state.handleEvent(evt('PreToolUse', { toolName: 'Bash' }));
  clock.advance(100);
  state.handleEvent(evt('SessionEnd'));
  // Recreate the session id later — nothing from the old one may leak in.
  clock.advance(2000);
  assert.equal(state.snapshot().sessions.s1, undefined);
});

test('permission-gated tool reveals after approval, not during the card', async () => {
  // flavor-code fires PreToolUse, then blocks on PermissionRequest — the tool
  // only starts running once the user approves. The reveal must survive the
  // waiting window and surface afterwards.
  const { state, clock } = createStateWithClock();
  const s = state.snapshot().sessions.s1;
  state.handleEvent(evt('PreToolUse', { toolName: 'Bash', toolDescription: 'npm test' }));
  const decision = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'npm test' },
  }));
  assert.equal(s.status, Status.waitingApproval);

  clock.advance(1000); // reveal fires mid-wait: must not drop the pending tool
  state.resolvePermission(state.listPending()[0].key, 'allow');
  assert.equal(await decision, 'allow');
  assert.equal(s.currentTool, null); // re-armed, still inside its reveal delay

  clock.advance(299);
  assert.equal(s.currentTool, null);
  clock.advance(1);
  assert.equal(s.currentTool, 'Bash');
  assert.equal(s.status, Status.running);
});

test('denied tool never surfaces', async () => {
  const { state, clock } = createStateWithClock();
  const s = state.snapshot().sessions.s1;
  state.handleEvent(evt('PreToolUse', { toolName: 'Bash' }));
  const decision = state.requestPermission(evt('PermissionRequest', {
    toolName: 'Bash', toolInput: { command: 'rm -rf /' },
  }));
  clock.advance(1000);
  state.resolvePermission(state.listPending()[0].key, 'deny');
  assert.equal(await decision, 'deny');
  clock.advance(5000);
  assert.equal(s.currentTool, null);
  assert.notEqual(s.status, Status.running);
});
