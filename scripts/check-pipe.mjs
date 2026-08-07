import net from 'node:net';

function endpoint() {
  if (process.platform === 'win32') {
    if (process.env.CODEISLAND_PIPE) return process.env.CODEISLAND_PIPE;
    const USER = (process.env.USERNAME || process.env.USER || 'default').trim() || 'default';
    return `\\\\.\\pipe\\codeisland-${USER}`;
  }
  if (process.env.CODEISLAND_SOCKET_PATH) return process.env.CODEISLAND_SOCKET_PATH;
  return `/tmp/codeisland-${process.getuid ? process.getuid() : 0}.sock`;
}

const PIPE = endpoint();
try {
  await new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    s.on('connect', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  });
  console.log('ENDPOINT IS LISTENING:', PIPE);
} catch (e) {
  console.log('ENDPOINT NOT LISTENING:', e.message);
}
