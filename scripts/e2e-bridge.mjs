// E2E check: real bridge.mjs (as flavor-code would run it) against a real
// hookServer. Uses CODEISLAND_PIPE to avoid the production pipe.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHookServer } = require('../src/server/hookServer.js');

const PIPE = `\\\\.\\pipe\\flavor-island-e2e-${process.pid}`;
const received = [];

const server = createHookServer({
  pipe: PIPE,
  onEvent: (e) => { received.push(e); },
  onPermission: async (e) => { received.push(e); return 'allow'; },
  onQuestion: () => null,
  onAskUserQuestion: async () => null,
});
await server.start();
console.log('server listening on', PIPE);

function runBridge(event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/plugin/bridge.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEISLAND_PIPE: PIPE },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.end(JSON.stringify(event));
  });
}

// 1. Non-blocking lifecycle event (what flavor-code's SessionStart emits).
const r1 = await runBridge({ version: 1, type: 'SessionStart', payload: { workspace: 'C:\\proj\\flavor-code' } });
console.log('SessionStart bridge exit:', r1.code);

// 2. UserPromptSubmit with prompt.
const r2 = await runBridge({ version: 1, type: 'UserPromptSubmit', payload: { prompt: 'build the island' } });
console.log('UserPromptSubmit bridge exit:', r2.code);

// 3. Blocking PermissionRequest -> island auto-allows -> decision on stdout.
const r3 = await runBridge({
  version: 1, type: 'PermissionRequest',
  payload: { tool: 'Shell', input: { command: 'npm test' }, agent: 'main', reason: 'Shell command requires approval' },
});
console.log('PermissionRequest bridge exit:', r3.code, 'stdout:', r3.stdout.trim());
if (r3.stderr.trim()) console.log('bridge stderr:', r3.stderr.trim());

await new Promise((r) => setTimeout(r, 100));
console.log('events received by island:');
for (const e of received) {
  console.log(' -', e.eventName, '| tool:', e.toolName, '| cwd:', e.rawJSON.cwd, '| prompt:', e.rawJSON.prompt, '| desc:', e.toolDescription);
}

const ok = received.length === 3
  && received[0].rawJSON.cwd === 'C:\\proj\\flavor-code'
  && received[1].rawJSON.prompt === 'build the island'
  && received[2].toolName === 'Shell'
  && JSON.parse(r3.stdout).decision === 'allow';
await server.stop();
console.log(ok ? 'E2E OK' : 'E2E FAILED');
process.exit(ok ? 0 : 1);
