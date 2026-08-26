'use strict';

// Pure transform: flavor-code hook event {type, payload} → flat bridge object.
//
// Extracted from bridge.mjs so the mapping logic is unit-testable without
// spawning the one-shot relay process. bridge.mjs keeps only transport: it
// reads one event from stdin, forwards the transformed object over the pipe,
// and (for blocking PermissionRequest events) prints the island's decision.
//
// The flat shape mirrors CodeIsland's bridge protocol: snake_case fields at
// the top level, with tool_input kept as an object and its string values also
// flattened for convenience.

const MAX_INPUT_STRING = 1200;
const MAX_OUTPUT_STRING = 2000;
const SAFE_INPUT_KEYS = new Set([
  'command', 'description', 'file_path', 'path', 'pattern', 'query', 'url',
  'prompt', 'question', 'options', 'questions', 'offset', 'limit', 'line',
]);

function redact(value) {
  return String(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/([?&](?:token|key|secret|signature)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function safeString(value, max = MAX_INPUT_STRING) {
  return redact(value).slice(0, max);
}

function sanitizeOptions(options) {
  if (!Array.isArray(options)) return undefined;
  return options.slice(0, 30).map((option) => {
    if (typeof option === 'string') return safeString(option, 300);
    if (!option || typeof option !== 'object') return String(option).slice(0, 100);
    const clean = {};
    for (const key of ['label', 'description', 'value']) {
      if (typeof option[key] === 'string') clean[key] = safeString(option[key], 300);
    }
    return clean;
  });
}

function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return undefined;
  return questions.slice(0, 20).map((question) => {
    if (!question || typeof question !== 'object') return {};
    const clean = {};
    for (const key of ['question', 'header']) {
      if (typeof question[key] === 'string') clean[key] = safeString(question[key], 800);
    }
    if (typeof question.multiSelect === 'boolean') clean.multiSelect = question.multiSelect;
    const options = sanitizeOptions(question.options);
    if (options) clean.options = options;
    return clean;
  });
}

function sanitizeToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_INPUT_KEYS.has(key)) continue;
    if (typeof value === 'string') clean[key] = safeString(value);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
    else if (key === 'options') clean[key] = sanitizeOptions(value);
    else if (key === 'questions') clean[key] = sanitizeQuestions(value);
  }
  return Object.keys(clean).length ? clean : undefined;
}

function stringifyBounded(value, max = MAX_OUTPUT_STRING) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
      if (text === undefined) text = String(value);
    } catch {
      text = String(value);
    }
  }
  return safeString(text, max);
}

function sanitizeVerification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean = {};
  if (typeof value.passed === 'boolean') clean.passed = value.passed;
  if (typeof value.summary === 'string') clean.summary = safeString(value.summary, 1000);
  if (Array.isArray(value.commands)) {
    clean.commands = value.commands.slice(0, 30).map((command) => {
      if (!command || typeof command !== 'object') return {};
      const item = {};
      if (typeof command.command === 'string') item.command = safeString(command.command, 500);
      if (Array.isArray(command.args)) item.args = command.args.slice(0, 30).map((arg) => safeString(arg, 200));
      if (typeof command.exitCode === 'number') item.exitCode = command.exitCode;
      if (typeof command.truncated === 'boolean') item.truncated = command.truncated;
      return item;
    });
  }
  return clean;
}

function sanitizeTaskSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const clean = {};
  if (typeof value.foregroundTaskId === 'string') clean.foregroundTaskId = safeString(value.foregroundTaskId, 200);
  if (value.plan && typeof value.plan === 'object' && Array.isArray(value.plan.tasks)) {
    clean.plan = { tasks: value.plan.tasks.slice(0, 100).map((task) => {
      if (!task || typeof task !== 'object') return {};
      const item = {};
      for (const key of ['id', 'subject', 'activeForm', 'status']) {
        if (typeof task[key] === 'string') item[key] = safeString(task[key], key === 'id' ? 200 : 800);
      }
      if (Array.isArray(task.dependencies)) item.dependencies = task.dependencies.slice(0, 100).filter((id) => typeof id === 'string').map((id) => safeString(id, 200));
      return item;
    }) };
  }
  if (value.subagents && typeof value.subagents === 'object') {
    const subagents = {};
    if (value.subagents.states && typeof value.subagents.states === 'object') {
      subagents.states = Object.fromEntries(Object.entries(value.subagents.states).slice(0, 200));
    }
    if (value.subagents.graph && typeof value.subagents.graph === 'object' && Array.isArray(value.subagents.graph.nodes)) {
      subagents.graph = { nodes: value.subagents.graph.nodes.slice(0, 100).map((node) => ({
        ...(typeof node?.id === 'string' ? { id: safeString(node.id, 200) } : {}),
        ...(typeof node?.description === 'string' ? { description: safeString(node.description, 800) } : {}),
        ...(Array.isArray(node?.dependencies) ? { dependencies: node.dependencies.slice(0, 100).filter((id) => typeof id === 'string').map((id) => safeString(id, 200)) } : {}),
      })) };
    }
    clean.subagents = subagents;
  }
  return clean;
}

export function transformEvent(event) {
  const payload = event.payload || {};
  const result = {
    hook_event_name: event.type,
    session_id: typeof payload.sessionId === 'string'
      ? payload.sessionId
      : `flavor-${process.ppid || process.pid}`,
    _source: 'flavor-code',
    _ppid: process.ppid || process.pid,
  };
  if (typeof payload.protocolVersion === 'number') result.protocol_version = payload.protocolVersion;
  if (typeof payload.eventId === 'string') result.event_id = payload.eventId;
  if (typeof payload.sequence === 'number') result.event_sequence = payload.sequence;
  if (typeof payload.timestamp === 'string') result.event_timestamp = payload.timestamp;
  if (typeof payload.toolCallId === 'string') result.tool_use_id = payload.toolCallId;
  if (typeof payload.tool === 'string') result.tool_name = payload.tool;
  if (typeof payload.agent === 'string') result.agent_type = payload.agent;
  const safeInput = sanitizeToolInput(payload.input);
  if (safeInput) {
    result.tool_input = safeInput;
    for (const [key, value] of Object.entries(safeInput)) {
      if (typeof value === 'string' && !(key in result)) result[key] = value;
    }
  }
  if (typeof payload.reason === 'string') {
    result.message = safeString(payload.reason, 1000);
    result.approval_reason = result.message;
  }
  if (typeof payload.toolCategory === 'string') result.tool_category = payload.toolCategory;
  if (typeof payload.allowAlways === 'boolean') result.allow_always = payload.allowAlways;
  if (typeof payload.message === 'string' && !result.message) result.message = safeString(payload.message, 1000);
  if (typeof payload.taskId === 'string') result.agent_id = payload.taskId;
  else if (typeof payload.id === 'string') result.agent_id = payload.id;
  if (typeof payload.description === 'string' && !result.message) result.message = safeString(payload.description, 1000);
  if (typeof payload.modelId === 'string') result.model = payload.modelId;
  if (typeof payload.iteration === 'number') result.message = `iteration ${payload.iteration}`;
  // flavor-code lifecycle payloads the baked-in bridge drops:
  //   SessionStart/SessionEnd -> { workspace }  (project title on the island)
  //   UserPromptSubmit        -> { prompt }     (last user message)
  //   Stop                    -> { outcome }    (completed/interrupted/…)
  if (typeof payload.workspace === 'string') result.cwd = payload.workspace;
  if (typeof payload.prompt === 'string') result.prompt = safeString(payload.prompt, 1200);
  if (typeof payload.outcome === 'string') result.stop_reason = payload.outcome;
  if (typeof payload.kind === 'string') result.notification_kind = payload.kind;
  if (typeof payload.question === 'string') result.question = safeString(payload.question, 1200);
  if (Array.isArray(payload.options)) result.question_options = sanitizeOptions(payload.options);
  if (typeof payload.islandControlEndpoint === 'string') result.island_control_endpoint = payload.islandControlEndpoint;
  if (typeof payload.islandControlToken === 'string') result.island_control_token = payload.islandControlToken;
  if (Array.isArray(payload.islandControlCapabilities)) {
    result.island_control_capabilities = payload.islandControlCapabilities.filter((item) => typeof item === 'string').slice(0, 10);
  }

  // Task snapshots are already bounded, JSON-safe view state produced by
  // flavor-code. Keep the nested shape intact so the island can render both
  // TaskPlan/Todo items and the subagent graph without losing dependencies.
  if (payload.taskSnapshot && typeof payload.taskSnapshot === 'object') {
    result.task_snapshot = sanitizeTaskSnapshot(payload.taskSnapshot);
  }

  if (event.type === 'LoopEnd') {
    if (typeof payload.loopId === 'string') result.loop_id = payload.loopId;
    if (typeof payload.outcome === 'string') result.loop_outcome = payload.outcome;
    if (typeof payload.reason === 'string') result.loop_reason = payload.reason;
    if (payload.verification && typeof payload.verification === 'object') {
      result.loop_verification = sanitizeVerification(payload.verification);
    }
  }

  // PostToolUse carries the tool result ({ tool, input, agent, output }). The
  // output can be a huge stream, so normalize it to a truncated string — the
  // island only shows a peek, and the pipe has a 1MB cap. Only set the field
  // when something meaningful survives normalization.
  if (payload.output !== undefined && payload.output !== null) {
    const text = stringifyBounded(payload.output);
    if (text) result.tool_output = text;
  }

  // PostToolUseFailure carries { error: { code, message } }. The island shows
  // the human-readable message; truncate so one noisy failure can't flood the
  // panel. Only set when the message is non-empty.
  if (payload.error && typeof payload.error.message === 'string') {
    const errMsg = safeString(payload.error.message, 300);
    if (errMsg) result.tool_error = errMsg;
  }

  // AfterModelCall carries provider-side failure info ({ providerError,
  // errorMessage }). The island surfaces it as a model error so a stalled
  // agent doesn't read as plain "thinking".
  if (typeof payload.providerError === 'boolean') result.providerError = payload.providerError;
  if (typeof payload.errorMessage === 'string') result.errorMessage = safeString(payload.errorMessage, 500);
  if (typeof payload.durationMs === 'number') result.model_duration_ms = payload.durationMs;
  if (typeof payload.inputTokens === 'number') result.input_tokens = payload.inputTokens;
  if (typeof payload.outputTokens === 'number') result.output_tokens = payload.outputTokens;
  if (typeof payload.cacheReadTokens === 'number') result.cache_read_tokens = payload.cacheReadTokens;
  if (typeof payload.cacheCreationTokens === 'number') result.cache_creation_tokens = payload.cacheCreationTokens;
  if (typeof payload.summary === 'string') result.summary = safeString(payload.summary, 2000);
  if (Array.isArray(payload.deliverables)) {
    result.deliverables = payload.deliverables.slice(0, 100).map((item) => ({
      ...(typeof item?.path === 'string' ? { path: safeString(item.path, 800) } : {}),
      ...(typeof item?.operation === 'string' ? { operation: safeString(item.operation, 20) } : {}),
      ...(typeof item?.added === 'number' ? { added: item.added } : {}),
      ...(typeof item?.removed === 'number' ? { removed: item.removed } : {}),
    }));
  }
  return result;
}
