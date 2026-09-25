'use strict';

// Transport endpoint between the flavor-code bridge plugin and this app.
//
// Keep this endpoint separate from CodeIsland's: both apps may run together.
//   win32   -> named pipe  \\.\pipe\flavor-island-<USERNAME>
//   darwin  -> unix socket /tmp/flavor-island-<uid>.sock
function pipePath(env = process.env, platform = process.platform, uid = process.getuid ? process.getuid() : 0) {
  if (platform === 'win32') {
    if (env.FLAVOR_ISLAND_PIPE && env.FLAVOR_ISLAND_PIPE.trim()) {
      return env.FLAVOR_ISLAND_PIPE.trim();
    }
    const user = (env.USERNAME || env.USER || 'default').trim() || 'default';
    return `\\\\.\\pipe\\flavor-island-${user}`;
  }
  if (env.FLAVOR_ISLAND_SOCKET_PATH && env.FLAVOR_ISLAND_SOCKET_PATH.trim()) {
    return env.FLAVOR_ISLAND_SOCKET_PATH.trim();
  }
  return `/tmp/flavor-island-${uid}.sock`;
}

module.exports = { pipePath };
