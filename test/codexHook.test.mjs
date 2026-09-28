import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toIslandEvent, codexDecision, endpoint } from '../plugins/flavor-island/scripts/codex-hook.mjs';

const hookPath = fileURLToPath(new URL('../plugins/flavor-island/scripts/codex-hook.mjs', import.meta.url));

function temporaryPipe() {
  const id = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\flavor-island-codex-${id}`
    : path.join(os.tmpdir(), `flavor-island-codex-${id}.sock`);
}

test('Codex events preserve identity and safe display data without a short-lived PID', () => {
  const event = toIslandEvent({
    hook_event_name: 'PreToolUse', session_id: 'thread-1', turn_id: 'turn-1',
    cwd: 'C:\\work', model: 'gpt-6-sol', tool_name: 'Bash', tool_use_id: 'call-1',
    tool_input: { command: 'echo ok', description: 'Run command', token: 'never forward' },
  });
  assert.equal(event._source, 'codex');
  assert.equal(event.tool_use_id, 'call-1');
  assert.equal(event.tool_input.command, 'echo ok');
  assert.equal(event.tool_input.token, undefined);
  assert.equal(event._ppid, undefined);
  assert.equal(event.model, 'gpt-6-sol');
  const redacted = toIslandEvent({
    hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash',
    tool_input: { command: 'curl -H "Authorization: Bearer abcdef123456" example.com' },
  });
  assert.ok(redacted.tool_input.command.includes('Bearer [REDACTED]'));
  assert.ok(!redacted.tool_input.command.includes('abcdef123456'));
});

test('compaction keeps the existing session, and interrupt ends its turn', () => {
  assert.equal(toIslandEvent({ hook_event_name: 'SessionStart', session_id: 's', source: 'compact' }).hook_event_name, 'PostCompact');
  const interrupted = toIslandEvent({ hook_event_name: 'Interrupt', session_id: 's' });
  assert.equal(interrupted.hook_event_name, 'Stop');
  assert.equal(interrupted.stop_reason, 'interrupted');
});

test('Codex approval returns only allow or deny and falls back to native prompt', () => {
  assert.deepEqual(codexDecision('{"hookSpecificOutput":{"decision":{"behavior":"allow","updatedPermissions":[1]}}}'), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.deepEqual(codexDecision('{"hookSpecificOutput":{"decision":{"behavior":"deny"}}}'), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
  });
  assert.deepEqual(codexDecision('{"islandDecision":"ask"}'), {});
  assert.deepEqual(codexDecision('broken'), {});
});

test('uses the same named pipe as Flavor Island on Windows', () => {
  assert.equal(endpoint({ USERNAME: 'tester' }, 'win32'), '\\\\.\\pipe\\flavor-island-tester');
});

test('hook process forwards a permission and prints a Codex decision', async () => {
  const pipe = temporaryPipe();
  const server = net.createServer((socket) => {
    let input = '';
    socket.on('data', (part) => {
      input += part.toString();
      if (!input.includes('\n')) return;
      const event = JSON.parse(input.split('\n')[0]);
      assert.equal(event.hook_event_name, 'PermissionRequest');
      assert.equal(event._source, 'codex');
      socket.end(JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow', updatedPermissions: [{}] } } }));
    });
  });
  await new Promise((resolve) => server.listen(pipe, resolve));
  try {
    const child = spawn(process.execPath, [hookPath], { env: {
      ...process.env,
      ...(process.platform === 'win32' ? { FLAVOR_ISLAND_PIPE: pipe } : { FLAVOR_ISLAND_SOCKET_PATH: pipe }),
    } });
    let stdout = '';
    child.stdout.on('data', (part) => { stdout += part.toString(); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unreachable island leaves approval to Codex', async () => {
  const pipe = temporaryPipe();
  const child = spawn(process.execPath, [hookPath], { env: {
    ...process.env,
    ...(process.platform === 'win32' ? { FLAVOR_ISLAND_PIPE: pipe } : { FLAVOR_ISLAND_SOCKET_PATH: pipe }),
  } });
  let stdout = '';
  child.stdout.on('data', (part) => { stdout += part.toString(); });
  child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash' }));
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), {});
});
