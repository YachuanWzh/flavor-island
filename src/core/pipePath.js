'use strict';

// Transport endpoint between the flavor-code bridge plugin and this app.
//
//   win32   -> named pipe  \\.\pipe\codeisland-<USERNAME>   (override: CODEISLAND_PIPE)
//   darwin  -> unix socket /tmp/codeisland-<uid>.sock       (override: CODEISLAND_SOCKET_PATH)
//
// The Windows pipe name matches the codeisland bridge that flavor-code bakes
// into `flavor init` projects, so baked-in plugins reach this app unchanged.
// The macOS socket path matches the original CodeIsland convention so the
// bundled flavor-island plugin and the app always agree on one address.
function pipePath(env = process.env, platform = process.platform, uid = process.getuid ? process.getuid() : 0) {
  if (platform === 'win32') {
    if (env.CODEISLAND_PIPE && env.CODEISLAND_PIPE.trim()) {
      return env.CODEISLAND_PIPE.trim();
    }
    const user = (env.USERNAME || env.USER || 'default').trim() || 'default';
    return `\\\\.\\pipe\\codeisland-${user}`;
  }
  if (env.CODEISLAND_SOCKET_PATH && env.CODEISLAND_SOCKET_PATH.trim()) {
    return env.CODEISLAND_SOCKET_PATH.trim();
  }
  return `/tmp/codeisland-${uid}.sock`;
}

module.exports = { pipePath };
