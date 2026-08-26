'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderModel } = require('../src/core/renderModel');
const { newSession, Status } = require('../src/core/sessionStore');

function session(status, overrides = {}) {
  const s = newSession();
  s.status = status;
  Object.assign(s, overrides);
  return s;
}

test('empty state yields collapsed empty model', () => {
  const m = renderModel({});
  assert.equal(m.collapsed, true);
  assert.equal(m.count, 0);
  assert.deepEqual(m.rows, []);
  assert.equal(m.mascotState, 'idle');
});

test('pending session expands the island', () => {
  const m = renderModel({
    sessions: { s1: session(Status.waitingApproval, { cwd: 'C:\\proj', currentTool: 'Bash' }) },
  });
  assert.equal(m.collapsed, false);
  assert.equal(m.requiresAttention, true);
  assert.equal(m.count, 1);
  assert.equal(m.rows[0].title, 'proj');
  assert.equal(m.rows[0].pending, true);
  assert.equal(m.mascotState, 'waiting');
});

test('quiet activity stays collapsed but mascot reflects top state', () => {
  const m = renderModel({
    sessions: { s1: session(Status.running, { currentTool: 'Read' }) },
  });
  assert.equal(m.collapsed, true);
  assert.equal(m.rows[0].statusLabel, 'Running · Read');
  assert.equal(m.mascotState, 'running');
});

test('waiting sessions sort above running above idle', () => {
  const m = renderModel({
    sessions: {
      idle: session(Status.idle),
      run: session(Status.running),
      ask: session(Status.waitingQuestion),
    },
  });
  assert.deepEqual(m.rows.map((r) => r.id), ['ask', 'run', 'idle']);
});

test('model and agent metadata surface in rows', () => {
  const m = renderModel({
    sessions: { s1: session(Status.processing, { model: 'deepseek-v3', source: 'flavor-code' }) },
  });
  assert.equal(m.rows[0].source, 'flavor-code');
});

test('planning status: label, key, and mascot state', () => {
  // Status.planning may not be landed yet by the parallel sessionStore change,
  // so fall back to the documented literal value of the contract.
  const m = renderModel({
    sessions: { s1: session(Status.planning ?? 'planning', { cwd: 'C:\\proj' }) },
  });
  assert.equal(m.rows[0].statusKey, 'planning');
  assert.equal(m.rows[0].statusLabel, 'Planning…');
  assert.equal(m.mascotState, 'processing');
});

test('planning sorts at the processing tier (below running, above idle)', () => {
  const m = renderModel({
    sessions: {
      idle: session(Status.idle),
      run: session(Status.running),
      plan: session(Status.planning ?? 'planning'),
    },
  });
  assert.deepEqual(m.rows.map((r) => r.id), ['run', 'plan', 'idle']);
});

test('row passes through detail fields from the session', () => {
  const startTime = 1712345678901;
  const m = renderModel({
    sessions: {
      s1: session(Status.processing, {
        model: 'deepseek:deepseek-v4-flash',
        failureCount: 3,
        interrupted: true,
        lastUserPrompt: 'fix the bug',
        lastToolOutput: 'npm test ok',
        lastToolError: 'Edit failed: no match',
        lastModelError: 'rate limit exceeded',
        startTime,
      }),
    },
  });
  const row = m.rows[0];
  assert.equal(row.model, 'deepseek:deepseek-v4-flash');
  assert.equal(row.failureCount, 3);
  assert.equal(row.interrupted, true);
  assert.equal(row.lastUserPrompt, 'fix the bug');
  assert.equal(row.lastToolOutput, 'npm test ok');
  assert.equal(row.lastToolError, 'Edit failed: no match');
  assert.equal(row.lastModelError, 'rate limit exceeded');
  assert.equal(row.startTime, startTime);
});

test('missing detail fields default to null/zero values', () => {
  const m = renderModel({
    sessions: { s1: session(Status.idle, { startTime: undefined }) },
  });
  const row = m.rows[0];
  assert.equal(row.model, null);
  assert.equal(row.failureCount, 0);
  assert.equal(row.interrupted, false);
  assert.equal(row.lastUserPrompt, null);
  assert.equal(row.lastToolOutput, null);
  assert.equal(row.lastToolError, null);
  assert.equal(row.lastModelError, null);
  assert.equal(row.startTime, 0);
});

test('history is limited to the most recent 10 entries', () => {
  const history = Array.from({ length: 15 }, (_, i) => ({
    tool: `Tool${i}`,
    description: `desc${i}`,
    success: i % 2 === 0,
    timestamp: 1000 + i,
  }));
  const m = renderModel({ sessions: { s1: session(Status.idle, { history }) } });
  const row = m.rows[0];
  assert.equal(row.history.length, 10);
  assert.equal(row.history[0].tool, 'Tool5');
  assert.equal(row.history[9].tool, 'Tool14');
  assert.deepEqual(row.history[9], history[14]);
});

test('history is an empty array when the session has none', () => {
  const m = renderModel({ sessions: { s1: session(Status.idle) } });
  assert.deepEqual(m.rows[0].history, []);
});

test('active task snapshot expands with ordinal and live task list', () => {
  const taskSnapshot = {
    plan: { tasks: [
      { id: 't1', subject: 'Inspect', activeForm: 'Inspecting', status: 'completed', dependencies: [] },
      { id: 't2', subject: 'Cache layer', activeForm: 'Implementing cache layer', status: 'in_progress', dependencies: ['t1'] },
      { id: 't3', subject: 'Verify', activeForm: 'Verifying', status: 'pending', dependencies: ['t2'] },
    ] },
    subagents: { states: {} },
  };
  const m = renderModel({ sessions: { s1: session(Status.processing, { taskSnapshot }) } });
  assert.equal(m.collapsed, false);
  assert.equal(m.rows[0].taskProgress.summary, 'task 2/3 · Implementing cache layer');
  assert.deepEqual(m.rows[0].taskProgress.tasks.map((task) => task.status), ['completed', 'in_progress', 'pending']);
});

test('subagent graph becomes a task list when no foreground plan exists', () => {
  const taskSnapshot = {
    subagents: {
      graph: { nodes: [{ id: 'a', description: 'Review API', dependencies: [] }, { id: 'b', description: 'Run tests', dependencies: ['a'] }] },
      states: { a: 'completed', b: 'running' },
    },
  };
  const m = renderModel({ sessions: { s1: session(Status.running, { taskSnapshot }) } });
  assert.equal(m.rows[0].taskProgress.summary, 'task 2/2 · Run tests');
});

test('loop terminal result keeps the island expanded for verification evidence', () => {
  const loopOutcome = { outcome: 'failed', reason: 'tests failed', verification: { passed: false, summary: '1 test failed' } };
  const m = renderModel({ sessions: { s1: session(Status.idle, { loopOutcome }) } });
  assert.equal(m.collapsed, false);
  assert.deepEqual(m.rows[0].loopOutcome, loopOutcome);
});
