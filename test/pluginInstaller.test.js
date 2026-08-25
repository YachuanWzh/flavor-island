'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installPlugin, pluginInstallDir, PLUGIN_FILES } = require('../src/main/pluginInstaller');

function makeTmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flavor-island-installer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('PLUGIN_FILES ships the persistent bridge files', () => {
  assert.ok(PLUGIN_FILES.includes('flavor-plugin.json'));
  assert.ok(PLUGIN_FILES.includes('activate.mjs'));
  assert.ok(PLUGIN_FILES.includes('bridgeDaemon.mjs'));
  assert.ok(PLUGIN_FILES.includes('eventTransform.mjs'));
  assert.ok(PLUGIN_FILES.includes('bridgeProtocol.mjs'));
  assert.ok(PLUGIN_FILES.includes('bridgeRelay.mjs'));
  assert.ok(!PLUGIN_FILES.includes('bridge.mjs'), 'one-shot bridge.mjs must not ship');
});

test('installPlugin writes new files and prunes stale bridge.mjs', (t) => {
  const home = makeTmpHome(t);
  const dir = pluginInstallDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge.mjs'), 'stale');
  installPlugin(home);
  for (const name of PLUGIN_FILES) {
    assert.ok(fs.existsSync(path.join(dir, name)), `missing ${name}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'bridge.mjs')), 'stale bridge.mjs must be removed');
});

test('installPlugin is idempotent and only rewrites changed content', (t) => {
  const home = makeTmpHome(t);
  const dir = pluginInstallDir(home);
  installPlugin(home);
  const target = path.join(dir, 'activate.mjs');
  const mtime1 = fs.statSync(target).mtimeMs;
  installPlugin(home);
  const mtime2 = fs.statSync(target).mtimeMs;
  assert.equal(mtime1, mtime2, 'unchanged file must not be rewritten');
});
