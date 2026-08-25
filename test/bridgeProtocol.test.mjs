// Frame protocol tests for the flavor-code → island persistent bridge.
// Kept as .mjs to match the ESM plugin sources it exercises.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRequest, decodeResponse, nextId } from '../src/plugin/bridgeProtocol.mjs';

test('encodeRequest produces one newline-terminated JSON line', () => {
  const line = encodeRequest(7, { type: 'PreToolUse', payload: { tool: 'Read' } }, false);
  assert.equal(typeof line, 'string');
  assert.ok(line.endsWith('\n'));
  const parsed = JSON.parse(line);
  assert.equal(parsed.id, 7);
  assert.equal(parsed.wait, false);
  assert.deepEqual(parsed.event, { type: 'PreToolUse', payload: { tool: 'Read' } });
});

test('encodeRequest with wait=true sets the wait flag', () => {
  const parsed = JSON.parse(encodeRequest(1, { type: 'PermissionRequest', payload: {} }, true));
  assert.equal(parsed.wait, true);
});

test('decodeResponse parses an ok frame', () => {
  const out = decodeResponse('{"id":3,"ok":true,"decision":{"decision":"allow"}}\n');
  assert.deepEqual(out, { id: 3, ok: true, decision: { decision: 'allow' } });
});

test('decodeResponse parses an error frame', () => {
  const out = decodeResponse('{"id":4,"ok":false,"reason":"pipe down"}\n');
  assert.deepEqual(out, { id: 4, ok: false, reason: 'pipe down' });
});

test('decodeResponse returns null for malformed lines', () => {
  assert.equal(decodeResponse('not json\n'), null);
  assert.equal(decodeResponse(''), null);
});

test('nextId increments monotonically', () => {
  const a = nextId();
  const b = nextId();
  assert.equal(b, a + 1);
});
