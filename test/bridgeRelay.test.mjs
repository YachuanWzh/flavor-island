// Client-half tests for the persistent bridge: inject a fake spawn so the
// relay's framing, pending-map, crash recovery, and abort handling are tested
// without real child processes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeRelay } from '../src/plugin/bridgeRelay.mjs';

// Fake child: EventEmitter with Writable-like stdin/stdout we control.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = {
    writes: [],
    errorHandlers: [],
    write(line) { this.writes.push(line); return true; },
    end() {},
    on(name, fn) { if (name === 'error') this.errorHandlers.push(fn); return this; },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function makeRelay() {
  const calls = [];
  const deps = {
    execPath: 'node',
    bridgePath: '/x/bridgeDaemon.mjs',
    spawn: (...args) => {
      const c = fakeChild();
      calls.push({ args, child: c });
      return c;
    },
  };
  const relay = createBridgeRelay(deps);
  return { relay, calls };
}

const EVENT = { type: 'PreToolUse', payload: { tool: 'Read' } };
const PERM = { type: 'PermissionRequest', payload: { tool: 'Bash', agent: 'main' } };

function emitLine(child, line) {
  child.stdout.emit('data', Buffer.from(line));
}

// The request id is allocated by the module-level counter, so tests must echo
// the id back from the frame the client actually wrote.
function requestId(child) {
  return JSON.parse(child.stdin.writes[child.stdin.writes.length - 1]).id;
}

function responseFrame(child, payload) {
  return JSON.stringify({ id: requestId(child), ...payload }) + '\n';
}

test('non-blocking event spawns the daemon once and returns allow immediately', async () => {
  const { relay, calls } = makeRelay();
  const decision = await relay.relay(EVENT, new AbortController().signal);
  assert.deepEqual(decision, { decision: 'allow' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'node');
  assert.deepEqual(calls[0].args[1], ['/x/bridgeDaemon.mjs']);
  assert.equal(calls[0].args[2].env.ELECTRON_RUN_AS_NODE, '1');
  const parsed = JSON.parse(calls[0].child.stdin.writes[0]);
  assert.equal(parsed.wait, false);
  assert.deepEqual(parsed.event, EVENT);
});

test('reuses one daemon for successive events', async () => {
  const { relay, calls } = makeRelay();
  await relay.relay(EVENT, new AbortController().signal);
  await relay.relay({ type: 'PostToolUse', payload: { tool: 'Read' } }, new AbortController().signal);
  assert.equal(calls.length, 1);
});

test('blocking request resolves with the daemon decision', async () => {
  const { relay, calls } = makeRelay();
  const promise = relay.relay(PERM, new AbortController().signal);
  const child = calls[0].child;
  const parsed = JSON.parse(child.stdin.writes[0]);
  assert.equal(parsed.wait, true);
  emitLine(child, responseFrame(child, { ok: true, decision: { decision: 'allow' } }));
  const decision = await promise;
  assert.deepEqual(decision, { decision: 'allow' });
});

test('blocking request resolves ask when the daemon dies first', async () => {
  const { relay, calls } = makeRelay();
  const promise = relay.relay(PERM, new AbortController().signal);
  calls[0].child.emit('close', 1);
  const decision = await promise;
  assert.deepEqual(decision, { decision: 'ask', reason: 'Flavor Island unavailable' });
});

test('daemon crash is recovered on the next call', async () => {
  const { relay, calls } = makeRelay();
  await relay.relay(EVENT, new AbortController().signal);
  calls[0].child.emit('close', 1);
  await relay.relay(EVENT, new AbortController().signal);
  assert.equal(calls.length, 2);
});

test('aborting a blocking request denies and does not leak pending', async () => {
  const { relay, calls } = makeRelay();
  const controller = new AbortController();
  const promise = relay.relay(PERM, controller.signal);
  controller.abort();
  const decision = await promise;
  assert.deepEqual(decision, { decision: 'deny', reason: 'Cancelled' });
  // Late daemon response must not resolve anything or leak the entry.
  emitLine(calls[0].child, responseFrame(calls[0].child, { ok: true, decision: { decision: 'allow' } }));
  assert.equal(relay.pendingCount(), 0);
});

test('dispose kills the daemon and settles pending as ask', async () => {
  const { relay, calls } = makeRelay();
  const promise = relay.relay(PERM, new AbortController().signal);
  await relay.dispose();
  const decision = await promise;
  assert.deepEqual(decision, { decision: 'ask', reason: 'Flavor Island unavailable' });
  assert.equal(calls[0].child.killed, true);
  assert.equal(relay.pendingCount(), 0);
});

test('blocking request with unreachable daemon write failure resolves ask', async () => {
  const { relay, calls } = makeRelay();
  await relay.relay(EVENT, new AbortController().signal); // spawns the daemon
  // Make the fake stdin throw on write, as a dead daemon's EPIPE would surface.
  calls[0].child.stdin.write = () => { throw new Error('EPIPE'); };
  const decision = await relay.relay(PERM, new AbortController().signal);
  assert.equal(decision.decision, 'ask');
  assert.equal(relay.pendingCount(), 0);
});
