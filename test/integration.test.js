'use strict';

// End-to-end integration: a fake flavor-code bridge connects to the hook server
// over a real named pipe, the appState resolves the blocking decision, and the
// bridge receives the allow/deny JSON — mirroring how the real flavor-code
// codeisland plugin (bridge.mjs) talks to this app.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHookServer } = require('../src/server/hookServer');
const { createAppState } = require('../src/main/appState');

function makePipe() {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const base = path.join(os.tmpdir(), `flavor-island-int-${suffix}`);
  return process.platform === 'win32' ? `\\\\.\\pipe\\flavor-island-${suffix}` : base;
}

// Mimic flavor-code's bridge.mjs: connect, write JSON + '\n', wait for the
// response, resolve with it.
function bridgeSend(pipe, event) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let data = '';
    socket.on('connect', () => socket.write(JSON.stringify(event) + '\n'));
    socket.on('data', (d) => { data += d.toString('utf8'); });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

test('full permission flow: event → wait → allow → bridge gets decision', async () => {
  const pipe = makePipe();
  const appState = createAppState();
  const server = createHookServer({
    pipe,
    onEvent: (e) => appState.handleEvent(e),
    onPermission: (e) => appState.requestPermission(e),
    onAskUserQuestion: (e) => appState.requestAskUserQuestion(e),
    onQuestion: () => null,
  });
  await server.start();

  try {
    // 1. A normal event flows into the state.
    await bridgeSend(pipe, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'flavor-1',
      _source: 'flavor-code',
      rawJSON: { prompt: 'build it' },
    });
    assert.equal(appState.snapshot().sessions['flavor-1'].status, 'processing');

    // 2. A blocking PermissionRequest waits for a human decision.
    const pendingReply = bridgeSend(pipe, {
      hook_event_name: 'PermissionRequest',
      session_id: 'flavor-1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf x' },
    });
    await new Promise((r) => setTimeout(r, 30));
    const pending = appState.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolName, 'Bash');

    // 3. User clicks Allow → bridge receives the allow decision.
    appState.resolvePermission(pending[0].key, 'allow');
    const reply = JSON.parse(await pendingReply);
    assert.equal(reply.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(reply.hookSpecificOutput.decision.behavior, 'allow');

    // 4. After resolution the session leaves the waiting state.
    assert.equal(appState.snapshot().sessions['flavor-1'].status, 'processing');
  } finally {
    await server.stop();
  }
});

test('full AskUserQuestion flow: bridge sends, UI answers, bridge gets allow+answers', async () => {
  const pipe = makePipe();
  const appState = createAppState();
  const server = createHookServer({
    pipe,
    onEvent: (e) => appState.handleEvent(e),
    onPermission: (e) => appState.requestPermission(e),
    onAskUserQuestion: (e) => appState.requestAskUserQuestion(e),
    onQuestion: () => null,
  });
  await server.start();

  try {
    const pendingReply = bridgeSend(pipe, {
      hook_event_name: 'PermissionRequest',
      session_id: 'flavor-2',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Which plan?', options: [{ label: 'A' }, { label: 'B' }] },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    const pending = appState.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'askUserQuestion');

    appState.resolveAskUserQuestion(pending[0].key, { 'Which plan?': 'B' });
    const reply = JSON.parse(await pendingReply);
    assert.equal(reply.hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(reply.hookSpecificOutput.decision.updatedInput.answers['Which plan?'], 'B');
  } finally {
    await server.stop();
  }
});

test('deny path returns deny decision to bridge', async () => {
  const pipe = makePipe();
  const appState = createAppState();
  const server = createHookServer({
    pipe,
    onEvent: (e) => appState.handleEvent(e),
    onPermission: (e) => appState.requestPermission(e),
    onAskUserQuestion: (e) => appState.requestAskUserQuestion(e),
    onQuestion: () => null,
  });
  await server.start();

  try {
    const pendingReply = bridgeSend(pipe, {
      hook_event_name: 'PermissionRequest',
      session_id: 'flavor-3',
      tool_name: 'Read',
      tool_input: { file_path: 'C:\\secret.txt' },
    });
    await new Promise((r) => setTimeout(r, 30));
    appState.resolvePermission(appState.listPending()[0].key, 'deny');
    const reply = JSON.parse(await pendingReply);
    assert.equal(reply.hookSpecificOutput.decision.behavior, 'deny');
  } finally {
    await server.stop();
  }
});
