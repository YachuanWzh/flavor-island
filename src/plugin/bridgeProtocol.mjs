'use strict';

// Frame protocol between the flavor-code plugin's activate entry and the
// persistent bridge daemon. One frame per line (\n-terminated); JSON.stringify
// never emits a literal newline, so the delimiter is unambiguous (same
// convention as src/server/hookServer.js).

let seq = 0;

export function nextId() {
  seq += 1;
  return seq;
}

export function encodeRequest(id, event, wait) {
  return JSON.stringify({ id, event, wait }) + '\n';
}

export function decodeResponse(line) {
  if (typeof line !== 'string' || line.length === 0) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.id !== 'number') return null;
    if (parsed.ok === true && parsed.decision !== undefined) {
      return { id: parsed.id, ok: true, decision: parsed.decision };
    }
    if (parsed.ok === false) {
      return { id: parsed.id, ok: false, reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown error' };
    }
    return null;
  } catch {
    return null;
  }
}
