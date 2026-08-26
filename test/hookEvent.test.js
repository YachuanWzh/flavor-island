'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHookEvent } = require('../src/core/hookEvent');

test('parses a flavor-code bridge event', () => {
  const raw = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'flavor-1234',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run tests' },
    _source: 'flavor-code',
    _ppid: 1234,
  });
  const ev = parseHookEvent(Buffer.from(raw));
  assert.ok(ev);
  assert.equal(ev.eventName, 'PreToolUse');
  assert.equal(ev.sessionId, 'flavor-1234');
  assert.equal(ev.toolName, 'Bash');
  assert.deepEqual(ev.toolInput, { command: 'npm test', description: 'Run tests' });
  assert.equal(ev.rawJSON._source, 'flavor-code');
  assert.ok(ev.toolDescription.includes('npm test'));
});

test('rejects invalid JSON', () => {
  assert.equal(parseHookEvent(Buffer.from('not json')), null);
  assert.equal(parseHookEvent(Buffer.alloc(0)), null);
});

test('rejects non-object payloads', () => {
  assert.equal(parseHookEvent(Buffer.from('[1,2]')), null);
  assert.equal(parseHookEvent(Buffer.from('"str"')), null);
});

test('requires an event name', () => {
  assert.equal(parseHookEvent(Buffer.from('{"session_id":"x"}')), null);
});

test('keeps raw event name (normalization happens in routeKind/reducer)', () => {
  const ev = parseHookEvent(Buffer.from('{"hook_event_name":"pre_tool_use","session_id":"x"}'));
  assert.equal(ev.eventName, 'pre_tool_use');
});

test('remote host id prefixes session id', () => {
  const ev = parseHookEvent(Buffer.from('{"hook_event_name":"Stop","session_id":"abc","_remote_host_id":"host1"}'));
  assert.equal(ev.sessionId, 'remote:host1:abc');
});

test('parses protocol event and tool-call identities', () => {
  const ev = parseHookEvent(Buffer.from(JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 's1', event_id: 'e1', tool_use_id: 't1',
  })));
  assert.equal(ev.eventId, 'e1');
  assert.equal(ev.toolUseId, 't1');
});
