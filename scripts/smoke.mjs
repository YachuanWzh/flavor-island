// Electron launch smoke test: starts the app, waits for the named pipe to be
// listening, pushes a flavor-code-style event through it, verifies the app
// stays alive long enough for any GPU crash-loop to hit its fatal limit, then
// quits. Exits non-zero on any failure (early exit, missing pipe, or the
// "GPU process isn't usable" FATAL that kills the app on GPU-less machines).
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const USER = (process.env.USERNAME || process.env.USER || 'default').trim() || 'default';
const PIPE = process.platform === 'win32'
  ? `\\\\.\\pipe\\codeisland-${USER}`
  : `/tmp/codeisland-${process.getuid ? process.getuid() : 0}.sock`;

const electronBin = process.platform === 'win32'
  ? 'node_modules\\electron\\dist\\electron.exe'
  : 'node_modules/.bin/electron';

const child = spawn(electronBin, ['.'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.on('exit', (code) => { console.log(`electron exited with code ${code}`); });

async function waitForPipe(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`electron exited early (code ${child.exitCode})`);
    try {
      await new Promise((resolve, reject) => {
        const s = net.connect(PIPE);
        s.on('connect', () => { s.destroy(); resolve(); });
        s.on('error', reject);
      });
      return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('named pipe never came up');
}

function sendEvent(event) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PIPE);
    let data = '';
    s.on('connect', () => s.write(JSON.stringify(event) + '\n'));
    s.on('data', (d) => { data += d.toString('utf8'); });
    s.on('close', () => resolve(data));
    s.on('error', reject);
  });
}

try {
  console.log('waiting for pipe...');
  await waitForPipe();
  console.log('pipe is up');

  // Let the renderer finish loading (did-finish-load) before pushing events,
  // mirroring real usage where sessions start after the app has settled.
  await sleep(1000);

  const reply = await sendEvent({
    hook_event_name: 'PreToolUse',
    session_id: 'smoke-1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    _source: 'flavor-code',
  });
  console.log('event reply:', reply);

  // Hold the app alive well past the GPU crash-loop limit (~10 retries) so a
  // latent "GPU process isn't usable. Goodbye." FATAL would surface here.
  for (let i = 0; i < 15; i++) {
    if (child.exitCode !== null) {
      throw new Error(`electron exited during hold (code ${child.exitCode})`);
    }
    await sleep(300);
  }

  if (child.exitCode !== null) {
    throw new Error(`electron exited during smoke (code ${child.exitCode})`);
  }
  if (process.platform === 'win32' && /GPU process isn't usable/.test(stderr)) {
    throw new Error('FATAL: GPU process isn\'t usable (GPU acceleration still active)');
  }
  console.log('electron alive after event; no GPU FATAL');
  const gpuLines = stderr.split('\n').filter((l) => l.includes('gpu')).length;
  console.log(`gpu-related stderr lines: ${gpuLines}`);
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(500);
  if (stderr.trim()) console.log('--- full stderr ---\n' + stderr.trim() + '\n--- end stderr ---');
}
