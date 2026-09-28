// Codex command hook -> Flavor Island's existing local pipe protocol.
// This file is self-contained so the Codex plugin can be installed without
// copying the Electron application or flavor-code's plugin.
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const MAX_STDIN = 1024 * 1024;
const SAFE_INPUT_KEYS = new Set([
  'command', 'description', 'file_path', 'path', 'pattern', 'query', 'url',
  'prompt', 'question', 'offset', 'limit', 'line',
]);

function safeText(value, max = 1200) {
  return String(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, max);
}

function safeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_INPUT_KEYS.has(key)) continue;
    if (typeof value === 'string') result[key] = safeText(value);
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function safeOutput(value) {
  if (value === undefined || value === null) return undefined;
  try { return safeText(typeof value === 'string' ? value : JSON.stringify(value), 2000); }
  catch { return undefined; }
}

export function toIslandEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.hook_event_name !== 'string' || typeof input.session_id !== 'string') return null;

  // A compact-triggered SessionStart belongs to the existing conversation;
  // resetting it would erase its title, history, and active tool state.
  const eventName = input.hook_event_name === 'Interrupt' ? 'Stop'
    : input.hook_event_name === 'SessionStart' && input.source === 'compact' ? 'PostCompact'
      : input.hook_event_name;
  const event = {
    hook_event_name: eventName,
    session_id: input.session_id,
    _source: 'codex',
  };
  // Codex hooks run in short-lived child processes. Their PID must not be used
  // as the session host PID, or Flavor Island would retire a live session.
  if (typeof input.cwd === 'string') event.cwd = safeText(input.cwd, 800);
  if (typeof input.model === 'string') event.model = safeText(input.model, 120);
  if (typeof input.turn_id === 'string') event.turn_id = input.turn_id;
  if (typeof input.tool_name === 'string') event.tool_name = safeText(input.tool_name, 120);
  if (typeof input.tool_use_id === 'string') event.tool_use_id = input.tool_use_id;
  if (typeof input.agent_id === 'string') event.agent_id = input.agent_id;
  if (typeof input.agent_type === 'string') event.agent_type = safeText(input.agent_type, 120);
  const toolInput = safeInput(input.tool_input);
  if (toolInput) event.tool_input = toolInput;
  if (typeof input.prompt === 'string') event.prompt = safeText(input.prompt);
  if (typeof input.tool_input?.description === 'string') {
    event.approval_reason = safeText(input.tool_input.description, 1000);
  }
  if (eventName === 'PostToolUse') event.tool_output = safeOutput(input.tool_response);
  if (eventName === 'Stop') {
    event.stop_reason = input.hook_event_name === 'Interrupt' ? 'interrupted' : 'completed';
    if (typeof input.last_assistant_message === 'string') {
      event.summary = safeText(input.last_assistant_message, 2000);
    }
  }
  return event;
}

export function codexDecision(response) {
  try {
    const parsed = JSON.parse(response);
    const behavior = parsed?.hookSpecificOutput?.decision?.behavior;
    if (behavior === 'allow' || behavior === 'deny') {
      // Codex PermissionRequest currently rejects updatedPermissions and
      // updatedInput. The island only returns a decision for this one request.
      return { hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior },
      } };
    }
  } catch { /* Broken/unavailable island: use Codex's own approval UI. */ }
  return {};
}

export function endpoint(env = process.env, platform = process.platform, uid = process.getuid?.()) {
  if (platform === 'win32') {
    if (env.FLAVOR_ISLAND_PIPE?.trim()) return env.FLAVOR_ISLAND_PIPE.trim();
    const user = (env.USERNAME || env.USER || 'default').trim() || 'default';
    return `\\\\.\\pipe\\flavor-island-${user}`;
  }
  if (env.FLAVOR_ISLAND_SOCKET_PATH?.trim()) return env.FLAVOR_ISLAND_SOCKET_PATH.trim();
  return `/tmp/flavor-island-${uid ?? 0}.sock`;
}

export function sendToIsland(event, { pipe = endpoint(), timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(pipe);
    let response = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(response);
    };
    socket.setTimeout(timeoutMs, finish);
    socket.on('connect', () => socket.write(JSON.stringify(event) + '\n'));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > MAX_STDIN) finish();
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

async function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > MAX_STDIN) { process.stdout.write('{}\n'); return; }
  }
  let input;
  try { input = JSON.parse(data); } catch { process.stdout.write('{}\n'); return; }
  const event = toIslandEvent(input);
  if (!event) { process.stdout.write('{}\n'); return; }
  const approval = input.hook_event_name === 'PermissionRequest';
  const response = await sendToIsland(event, { timeoutMs: approval ? 590_000 : 1500 });
  process.stdout.write(JSON.stringify(approval ? codexDecision(response) : {}) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => process.stdout.write('{}\n'));
}
