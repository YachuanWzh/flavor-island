'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSessionCache, saveSessionCache } = require('../src/main/sessionCache');

test('session cache restores only live metadata without prompts or control credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flavor-island-cache-'));
  const file = path.join(dir, 'sessions.json');
  try {
    const now = Date.now();
    saveSessionCache(file, {
      live: { cwd: '/project', title: 'Task', source: 'flavor-code', cliPid: 123,
        status: 'running', currentTool: 'Bash', lastActivity: now, startTime: now,
        lastUserPrompt: 'secret', controlToken: 'secret', controlCapabilities: ['abort'] },
      dead: { cwd: '/old', cliPid: 456, status: 'running', lastActivity: now, startTime: now },
    });
    const restored = loadSessionCache(file, { now, isAlive: (pid) => pid === 123 });
    assert.deepEqual(Object.keys(restored), ['live']);
    assert.equal(restored.live.title, 'Task');
    assert.equal(restored.live.status, 'idle');
    assert.equal(restored.live.currentTool, null);
    assert.equal(restored.live.lastUserPrompt, undefined);
    assert.equal(restored.live.controlToken, undefined);
    assert.deepEqual(restored.live.controlCapabilities, []);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
