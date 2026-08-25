'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Installs the bundled flavor-island plugin into flavor-code's global plugin
// directory so every flavor-code session (any project, Windows or macOS)
// relays hook events to the island — no `flavor init` needed per project.
//
// flavor-code discovers plugins from:
//   global:  <home>/.flavor-code/plugins/<name>/
//   project: <workspace>/.flavor/plugins/<name>/
// (see flavor-code src/production.ts). The global tier is the right home for
// a companion app: one install covers all workspaces.

// bridgeDaemon.mjs imports eventTransform.mjs and bridgeProtocol.mjs via
// relative paths, and bridgeRelay.mjs is imported by activate.mjs, so all of
// them must ship together — omitting any one makes the plugin fail to load in
// flavor-code.
const PLUGIN_FILES = [
  'flavor-plugin.json',
  'activate.mjs',
  'bridgeDaemon.mjs',
  'bridgeRelay.mjs',
  'bridgeProtocol.mjs',
  'eventTransform.mjs',
];

// Legacy files older island versions installed but no longer used. Removed so
// a stale one-shot relay can't linger in flavor-code's plugin dir.
const STALE_FILES = ['bridge.mjs'];

function pluginInstallDir(home = os.homedir()) {
  return path.join(home, '.flavor-code', 'plugins', 'flavor-island');
}

function pluginSourceDir() {
  return path.join(__dirname, '..', 'plugin');
}

// Copy each plugin file into the target directory, writing only when content
// actually differs (a flavor-code session may be reading the plugin right now;
// unchanged files are left untouched). Stale files are pruned afterwards.
// Returns the install directory, or throws with the underlying error when
// installation fails.
function installPlugin(home = os.homedir()) {
  const destDir = pluginInstallDir(home);
  const srcDir = pluginSourceDir();
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of PLUGIN_FILES) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const content = fs.readFileSync(src);
    let existing = null;
    try { existing = fs.readFileSync(dest); } catch { /* missing — write it */ }
    if (!existing || !existing.equals(content)) {
      fs.writeFileSync(dest, content);
    }
  }
  for (const name of STALE_FILES) {
    const stale = path.join(destDir, name);
    try { fs.unlinkSync(stale); } catch { /* already gone */ }
  }
  return destDir;
}

module.exports = { installPlugin, pluginInstallDir, PLUGIN_FILES, STALE_FILES };
