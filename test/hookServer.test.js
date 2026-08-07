'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHookServer, routeKind } = require('../src/server/hookServer');

function makePipe() {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const base = path.join(os.tmpdir(), `flavor-island-test-${suffix}`);
  // Windows named pipes must start with \\.\pipe\; a file path works on Unix.
  return process.platform === 'win32' ? `\\\\.\\pipe\\flavor-island-${suffix}` : base;
}

function sendLine(pipe, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let data = '';
    socket.on('connect', () => socket.write(line));
    socket.on('data', (d) => { data += d.toString('utf8'); });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

test('routes plain events to onEvent and replies {}', async () => {
  const pipe = makePipe();
  const seen = [];
  const server = createHookServer({
    pipe,
    onEvent: (e) => seen.push(e),
  });
  await server.start();
  try {
    const reply = await sendLine(pipe, JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Bash',
    }) + '\n');
    assert.equal(reply, '{}');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].eventName, 'PreToolUse');
  } finally {
    await server.stop();
  }
});

test('permission events block until onPermission resolves', async () => {
  const pipe = makePipe();
  let resolvePerm;
  const server = createHookServer({
    pipe,
    onPermission: () => new Promise((r) => { resolvePerm = r; }),
  });
  await server.start();
  try {
    const replyPromise = sendLine(pipe, JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
    }) + '\n');
    // Give the server a tick to route before resolving.
    await new Promise((r) => setTimeout(r, 30));
    resolvePerm('allow');
    const reply = await replyPromise;
    const parsed = JSON.parse(reply);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'allow');
  } finally {
    await server.stop();
  }
});

test('AskUserQuestion permission routes to onAskUserQuestion', async () => {
  const pipe = makePipe();
  const server = createHookServer({
    pipe,
    onAskUserQuestion: () => Promise.resolve({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { answers: {} } } },
    }),
  });
  await server.start();
  try {
    const reply = await sendLine(pipe, JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Q1' }] },
    }) + '\n');
    const parsed = JSON.parse(reply);
    assert.equal(parsed.hookSpecificOutput.decision.behavior, 'allow');
  } finally {
    await server.stop();
  }
});

test('malformed payload replies parse_failed', async () => {
  const pipe = makePipe();
  const server = createHookServer({ pipe, onEvent: () => {} });
  await server.start();
  try {
    const reply = await sendLine(pipe, 'not json\n');
    assert.equal(reply, '{"error":"parse_failed"}');
  } finally {
    await server.stop();
  }
});

test('routeKind classifies events', () => {
  const base = (name, tool) => ({ eventName: name, toolName: tool, rawJSON: {} });
  assert.equal(routeKind(base('PermissionRequest', 'Bash')), 'permission');
  assert.equal(routeKind(base('PermissionRequest', 'AskUserQuestion')), 'askUserQuestion');
  assert.equal(routeKind({ ...base('Notification'), rawJSON: { question: 'hi' } }), 'question');
  assert.equal(routeKind(base('PreToolUse', 'Bash')), 'event');
});
