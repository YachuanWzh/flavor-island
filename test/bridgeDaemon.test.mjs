// End-to-end tests for the persistent bridge daemon: spawn the real process,
// point it at a fake island named-pipe server, and assert framing + decisions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON = path.join(ROOT, 'src', 'plugin', 'bridgeDaemon.mjs');

function makePipe() {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const base = path.join(os.tmpdir(), `flavor-island-daemon-test-${suffix}`);
  return process.platform === 'win32' ? `\\\\.\\pipe\\flavor-island-${suffix}` : base;
}

// Minimal fake island server: accepts one connection, reads one line, replies
// with `reply` (string) and closes. Returns { pipe, received, close }.
function fakeIsland(reply) {
  const pipe = makePipe();
  const received = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      received.push(buf.slice(0, nl));
      socket.end(reply);
    });
  });
  return new Promise((resolve) => {
    server.listen(pipe, () => resolve({
      pipe,
      received,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function startDaemon(pipe) {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CODEISLAND_PIPE: pipe },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

function requestLine(id, event, wait) {
  return JSON.stringify({ id, event, wait }) + '\n';
}

function collectOutput(child) {
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  return () => out;
}

test('daemon relays a fire-and-forget event to the island', async () => {
  const island = await fakeIsland('{}');
  try {
    const child = startDaemon(island.pipe);
    collectOutput(child);
    child.stdin.end(requestLine(1, { type: 'PreToolUse', payload: { tool: 'Read', agent: 'main', input: { file_path: 'a.js' } } }, false));
    await new Promise((r) => child.on('close', r));
    assert.equal(island.received.length, 1);
    const parsed = JSON.parse(island.received[0]);
    assert.equal(parsed.hook_event_name, 'PreToolUse');
    assert.equal(parsed.tool_name, 'Read');
  } finally {
    await island.close();
  }
});

test('daemon forwards a blocking permission request and writes the decision back', async () => {
  const reply = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  const island = await fakeIsland(reply);
  try {
    const child = startDaemon(island.pipe);
    const getOut = collectOutput(child);
    child.stdin.end(requestLine(2, { type: 'PermissionRequest', payload: { tool: 'Bash', agent: 'main' } }, true));
    await new Promise((r) => child.on('close', r));
    assert.equal(island.received.length, 1);
    const parsed = JSON.parse(getOut());
    assert.equal(parsed.id, 2);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.decision, { decision: 'allow' });
  } finally {
    await island.close();
  }
});

test('daemon maps allow-all updatedPermissions to additionalContext', async () => {
  const reply = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedPermissions: [{ type: 'addRules' }] },
    },
  });
  const island = await fakeIsland(reply);
  try {
    const child = startDaemon(island.pipe);
    const getOut = collectOutput(child);
    child.stdin.end(requestLine(4, { type: 'PermissionRequest', payload: { tool: 'Bash', agent: 'main' } }, true));
    await new Promise((r) => child.on('close', r));
    const parsed = JSON.parse(getOut());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.decision, { decision: 'allow', additionalContext: 'codeisland:allow-all' });
  } finally {
    await island.close();
  }
});

test('daemon carries AskUserQuestion answers back in updatedInput', async () => {
  const reply = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { answers: { 'Continue?': 'Yes' } },
      },
    },
  });
  const island = await fakeIsland(reply);
  try {
    const child = startDaemon(island.pipe);
    const getOut = collectOutput(child);
    child.stdin.end(requestLine(7, {
      type: 'PermissionRequest',
      payload: { tool: 'AskUserQuestion', agent: 'main', input: { questions: [{ header: 'H', question: 'Continue?', options: [{ label: 'Yes', description: 'Go' }] }] } },
    }, true));
    await new Promise((r) => child.on('close', r));
    const parsed = JSON.parse(getOut());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.decision, {
      decision: 'allow',
      updatedInput: {
        tool: 'AskUserQuestion',
        input: { answers: { 'Continue?': 'Yes' } },
        agent: 'main',
      },
    });
  } finally {
    await island.close();
  }
});

test('daemon carries a notification question answer back in updatedInput', async () => {
  const island = await fakeIsland(JSON.stringify({ answer: 'Continue' }));
  try {
    const child = startDaemon(island.pipe);
    const getOut = collectOutput(child);
    child.stdin.end(requestLine(8, {
      type: 'Notification', payload: { question: 'Extend budget?', options: ['Continue', 'Stop'] },
    }, true));
    await new Promise((r) => child.on('close', r));
    const parsed = JSON.parse(getOut());
    assert.deepEqual(parsed.decision, {
      decision: 'allow',
      updatedInput: { question: 'Extend budget?', options: ['Continue', 'Stop'], answer: 'Continue' },
    });
  } finally {
    await island.close();
  }
});

test('daemon returns an ask decision when the island pipe is unreachable', async () => {
  const child = startDaemon(makePipe()); // nothing listening
  const getOut = collectOutput(child);
  child.stdin.end(requestLine(3, { type: 'PermissionRequest', payload: { tool: 'Bash', agent: 'main' } }, true));
  await new Promise((r) => child.on('close', r));
  const parsed = JSON.parse(getOut());
  assert.equal(parsed.id, 3);
  assert.equal(parsed.ok, false);
  assert.equal(typeof parsed.reason, 'string');
  assert.ok(parsed.reason.length > 0);
});

test('daemon survives multiple requests on one stdin stream', async () => {
  const island = await fakeIsland('{}');
  try {
    const child = startDaemon(island.pipe);
    collectOutput(child);
    child.stdin.write(requestLine(5, { type: 'PreToolUse', payload: { tool: 'Read' } }, false));
    child.stdin.write(requestLine(6, { type: 'PostToolUse', payload: { tool: 'Read' } }, false));
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    assert.equal(island.received.length, 2);
  } finally {
    await island.close();
  }
});
