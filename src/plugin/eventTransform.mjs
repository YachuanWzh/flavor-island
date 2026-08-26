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
  if (payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)) {
    result.tool_input = payload.input;
    for (const [key, value] of Object.entries(payload.input)) {
      if (typeof value === 'string' && !(key in result)) result[key] = value;
    }
  }
  if (typeof payload.reason === 'string') {
    result.message = payload.reason;
    result.approval_reason = payload.reason;
  }
  if (typeof payload.toolCategory === 'string') result.tool_category = payload.toolCategory;
  if (typeof payload.allowAlways === 'boolean') result.allow_always = payload.allowAlways;
  if (typeof payload.message === 'string' && !result.message) result.message = payload.message;
  if (typeof payload.taskId === 'string') result.agent_id = payload.taskId;
  else if (typeof payload.id === 'string') result.agent_id = payload.id;
  if (typeof payload.description === 'string' && !result.message) result.message = payload.description;
  if (typeof payload.modelId === 'string') result.model = payload.modelId;
  if (typeof payload.iteration === 'number') result.message = `iteration ${payload.iteration}`;
  // flavor-code lifecycle payloads the baked-in bridge drops:
  //   SessionStart/SessionEnd -> { workspace }  (project title on the island)
  //   UserPromptSubmit        -> { prompt }     (last user message)
  //   Stop                    -> { outcome }    (completed/interrupted/…)
  if (typeof payload.workspace === 'string') result.cwd = payload.workspace;
  if (typeof payload.prompt === 'string') result.prompt = payload.prompt;
  if (typeof payload.outcome === 'string') result.stop_reason = payload.outcome;
  if (typeof payload.kind === 'string') result.notification_kind = payload.kind;
  if (typeof payload.question === 'string') result.question = payload.question;
  if (Array.isArray(payload.options)) result.question_options = payload.options;

  // Task snapshots are already bounded, JSON-safe view state produced by
  // flavor-code. Keep the nested shape intact so the island can render both
  // TaskPlan/Todo items and the subagent graph without losing dependencies.
  if (payload.taskSnapshot && typeof payload.taskSnapshot === 'object') {
    result.task_snapshot = payload.taskSnapshot;
  }

  if (event.type === 'LoopEnd') {
    if (typeof payload.loopId === 'string') result.loop_id = payload.loopId;
    if (typeof payload.outcome === 'string') result.loop_outcome = payload.outcome;
    if (typeof payload.reason === 'string') result.loop_reason = payload.reason;
    if (payload.verification && typeof payload.verification === 'object') {
      result.loop_verification = payload.verification;
    }
  }

  // PostToolUse carries the tool result ({ tool, input, agent, output }). The
  // output can be a huge stream, so normalize it to a truncated string — the
  // island only shows a peek, and the pipe has a 1MB cap. Only set the field
  // when something meaningful survives normalization.
  if (payload.output !== undefined && payload.output !== null) {
    let text;
    if (typeof payload.output === 'string') {
      text = payload.output;
    } else {
      try {
        text = JSON.stringify(payload.output);
        // JSON.stringify returns undefined for non-serializable values
        // (functions, symbols) without throwing — fall back to String().
        if (text === undefined) text = String(payload.output);
      } catch {
        text = String(payload.output);
      }
    }
    text = text.slice(0, 2000);
    if (text) result.tool_output = text;
  }

  // PostToolUseFailure carries { error: { code, message } }. The island shows
  // the human-readable message; truncate so one noisy failure can't flood the
  // panel. Only set when the message is non-empty.
  if (payload.error && typeof payload.error.message === 'string') {
    const errMsg = payload.error.message.slice(0, 300);
    if (errMsg) result.tool_error = errMsg;
  }

  // AfterModelCall carries provider-side failure info ({ providerError,
  // errorMessage }). The island surfaces it as a model error so a stalled
  // agent doesn't read as plain "thinking".
  if (typeof payload.providerError === 'boolean') result.providerError = payload.providerError;
  if (typeof payload.errorMessage === 'string') result.errorMessage = payload.errorMessage;
  return result;
}
