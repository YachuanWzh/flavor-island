'use strict';

// Locks down the bundled flavor-code plugin's hook registrations so the island
// and the manifest stay in sync with the events flavor-code emits. Reading the
// JSON parses the manifest; reading activate.mjs as text keeps the assertion
// pragmatic (a regex over the quoted names array) instead of importing ESM.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'src', 'plugin', 'flavor-plugin.json');
const ACTIVATE_PATH = path.join(ROOT, 'src', 'plugin', 'activate.mjs');

// The hook event names flavor-code's hook bus knows (HOOK_EVENT_NAMES in
// flavor-code/src/hooks/types.ts). Every manifest hook must be a member.
const KNOWN_HOOK_NAMES = new Set([
  'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd',
  'BeforePlan', 'AfterPlan', 'SubagentStart', 'SubagentStop',
  'BeforeModelCall', 'AfterModelCall', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact',
  'PluginLoad', 'PluginUnload', 'Notification',
]);

// The five events this task adds: model-call lifecycle, plan lifecycle, and the
// compaction recovery signal.
const NEW_HOOK_NAMES = ['BeforeModelCall', 'AfterModelCall', 'BeforePlan', 'AfterPlan', 'PostCompact'];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function manifestHookNames() {
  return readManifest().contributes.hooks.map((h) => h.name);
}

// Every quoted string in the `names` array literal of activate.mjs. Comments
// inside the array are stripped first so quoted words in prose (e.g. a
// "Planning…" description) don't count as registered hooks.
function activateHookNames() {
  const text = fs.readFileSync(ACTIVATE_PATH, 'utf8');
  const match = text.match(/const names\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(match, 'activate.mjs must contain a `const names = [...]` array');
  const body = match[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test('manifest declares the five new hook events', () => {
  const names = manifestHookNames();
  for (const name of NEW_HOOK_NAMES) {
    assert.ok(names.includes(name), `manifest missing hook ${name}`);
  }
});

test('activate.mjs registers the five new hook events', () => {
  const names = activateHookNames();
  for (const name of NEW_HOOK_NAMES) {
    assert.ok(names.includes(name), `activate.mjs missing hook ${name}`);
  }
});

test('manifest hooks are all known flavor-code hook names', () => {
  const names = manifestHookNames();
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(KNOWN_HOOK_NAMES.has(name), `manifest lists unknown hook ${name}`);
  }
});

test('manifest and activate.mjs registration lists match', () => {
  const manifest = manifestHookNames();
  const activate = activateHookNames();
  assert.deepEqual([...manifest].sort(), [...activate].sort());
});
