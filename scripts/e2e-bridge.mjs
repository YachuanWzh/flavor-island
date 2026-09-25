// E2E check: real bridgeDaemon.mjs (as flavor-code runs it) against a real
// hookServer. Uses FLAVOR_ISLAND_PIPE to avoid the production pipe.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHookServer } = require('../src/server/hookServer.js');
const { buildAllowResponse } = require('../src/core/askQuestion.js');

const PIPE = process.platform === 'win32'
  ? `\\\\.\\pipe\\flavor-island-e2e-${process.pid}`
  : path.join(os.tmpdir(), `flavor-island-e2e-${process.pid}.sock`);
const received = [];

const server = createHookServer({
  pipe: PIPE,
  onEvent: (e) => { received.push(e); },
  onPermission: async (e) => { received.push(e); return 'allow'; },
  onQuestion: () => null,
  // Answer the AskUserQuestion like the island UI would (allow + answers).
  onAskUserQuestion: async (e) => { received.push(e); return buildAllowResponse(e, { 'Pick one?': 'Option A' }); },
});
await server.start();
console.log('server listening on', PIPE);

function runBridge(event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/plugin/bridgeDaemon.mjs'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FLAVOR_ISLAND_PIPE: PIPE, FLAVOR_ISLAND_SOCKET_PATH: PIPE },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.end(JSON.stringify({ id: 1, event, wait: event.type === 'PermissionRequest' }) + '\n');
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

// 4. Blocking AskUserQuestion -> island answers -> updatedInput carries answers
// back in the hook-payload shape flavor-code's bus validates.
const r4 = await runBridge({
  version: 1, type: 'PermissionRequest',
  payload: {
    tool: 'AskUserQuestion',
    input: { questions: [{ question: 'Pick one?', header: 'Choice', options: [{ label: 'Option A', description: 'a' }, { label: 'Option B', description: 'b' }] }] },
    agent: 'main',
  },
});
console.log('AskUserQuestion bridge exit:', r4.code, 'stdout:', r4.stdout.trim());
if (r4.stderr.trim()) console.log('bridge stderr:', r4.stderr.trim());

await new Promise((r) => setTimeout(r, 100));
console.log('events received by island:');
for (const e of received) {
  console.log(' -', e.eventName, '| tool:', e.toolName, '| cwd:', e.rawJSON.cwd, '| prompt:', e.rawJSON.prompt, '| desc:', e.toolDescription);
}

const askDecision = JSON.parse(r4.stdout);
const ok = received.length === 4
  && received[0].rawJSON.cwd === 'C:\\proj\\flavor-code'
  && received[1].rawJSON.prompt === 'build the island'
  && received[2].toolName === 'Shell'
  && received[3].toolName === 'AskUserQuestion'
  && JSON.parse(r3.stdout).decision.decision === 'allow'
  && askDecision.decision.decision === 'allow'
  && askDecision.decision.updatedInput.tool === 'AskUserQuestion'
  && askDecision.decision.updatedInput.agent === 'main'
  && askDecision.decision.updatedInput.input.answers['Pick one?'] === 'Option A';
await server.stop();
console.log(ok ? 'E2E OK' : 'E2E FAILED');
process.exit(ok ? 0 : 1);
