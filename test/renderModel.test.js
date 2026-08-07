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
