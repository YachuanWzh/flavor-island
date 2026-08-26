'use strict';

const { normalize } = require('./eventNormalizer');

// Status values mirror CodeIsland's AgentStatus.
const Status = {
  idle: 'idle',
  processing: 'processing',
  running: 'running',
  planning: 'planning',
  waitingApproval: 'waitingApproval',
  waitingQuestion: 'waitingQuestion',
};

const MAX_HISTORY = 50;
const MAX_MESSAGES = 30;

function newSession() {
  return {
    status: Status.idle,
    source: null,
    cwd: null,
    model: null,
    cliPid: null,
    controlEndpoint: null,
    controlToken: null,
    controlCapabilities: [],
    currentTool: null,
    toolDescription: null,
    // The tool actually executing, independent of what the island displays
    // (the display layer debounces currentTool; history must not).
    activeTool: null,
    activeActivities: {},
    lastUserPrompt: null,
    lastAssistantMessage: null,
    lastToolOutput: null,
    lastToolError: null,
    failureCount: 0,
    lastModelError: null,
    interrupted: false,
    taskSnapshot: null,
    loopOutcome: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
      calls: 0,
    },
    deliverables: [],
    history: [],
    recentMessages: [],
    startTime: Date.now(),
    lastActivity: Date.now(),
  };
}

function ensure(sessions, id) {
  if (!sessions[id]) sessions[id] = newSession();
  return sessions[id];
}

function firstStringFromEvent(event, keys) {
  const raw = event.rawJSON || {};
  for (const k of keys) {
    if (typeof raw[k] === 'string' && raw[k].trim()) return raw[k];
  }
  for (const container of ['payload', 'data', 'input']) {
    const nested = raw[container];
    if (nested && typeof nested === 'object') {
      for (const k of keys) {
        if (typeof nested[k] === 'string' && nested[k].trim()) return nested[k];
      }
    }
  }
  return null;
}

function addMessage(session, msg) {
  session.recentMessages.push(msg);
  if (session.recentMessages.length > MAX_MESSAGES) session.recentMessages.shift();
}

function recordTool(session, tool, description, success) {
  session.history.push({ tool, description: description || null, success, timestamp: Date.now() });
  if (session.history.length > MAX_HISTORY) session.history.shift();
}

function activityKey(event, prefix) {
  return event.toolUseId || event.agentId || event.eventId || `${prefix}:legacy`;
}

function latestActivity(session) {
  return Object.values(session.activeActivities || {}).at(-1) || null;
}

function startActivity(session, key, activity) {
  session.activeActivities[key] = activity;
  session.activeTool = activity;
}

function finishActivity(session, event, prefix, success) {
  const activities = session.activeActivities || {};
  let key = activityKey(event, prefix);
  let activity = activities[key];
  if (!activity && event.toolName) {
    const matching = Object.entries(activities).filter(([, item]) => item.tool === event.toolName).at(-1);
    if (matching) [key, activity] = matching;
  }
  if (!activity) {
    const latest = Object.entries(activities).at(-1);
    if (latest) [key, activity] = latest;
  }
  if (activity) {
    recordTool(session, activity.tool, activity.description, success);
    delete activities[key];
  }
  session.activeTool = latestActivity(session);
  return session.activeTool;
}

function applyMetadata(session, raw) {
  if (typeof raw._source === 'string' && raw._source) session.source = raw._source;
  if (typeof raw.cwd === 'string' && raw.cwd) session.cwd = raw.cwd;
  if (typeof raw.model === 'string' && raw.model) session.model = raw.model;
  if (typeof raw._ppid === 'number' && raw._ppid > 0) session.cliPid = raw._ppid;
  if (typeof raw.island_control_endpoint === 'string' && raw.island_control_endpoint) {
    session.controlEndpoint = raw.island_control_endpoint;
  }
  if (typeof raw.island_control_token === 'string' && raw.island_control_token) {
    session.controlToken = raw.island_control_token;
  }
  if (Array.isArray(raw.island_control_capabilities)) {
    session.controlCapabilities = raw.island_control_capabilities.filter((item) => typeof item === 'string');
  }
}

// Pure reducer: mutates `sessions`, returns { effects }.
function reduceEvent(sessions, event) {
  const effects = [];
  if (!event) return { effects };

  const sessionId = event.sessionId || 'default';
  const eventName = normalize(event.eventName);
  const raw = event.rawJSON || {};

  if (eventName === 'SessionEnd') {
    effects.push({ type: 'removeSession', sessionId });
    return { effects };
  }

  if (eventName === 'SessionStart') {
    sessions[sessionId] = newSession();
  }
  const session = ensure(sessions, sessionId);
  applyMetadata(session, raw);

  const isWaiting = session.status === Status.waitingApproval || session.status === Status.waitingQuestion;

  switch (eventName) {
    case 'SessionStart':
      // metadata already applied; stays idle
      break;
    case 'UserPromptSubmit': {
      session.interrupted = false;
      session.loopOutcome = null;
      session.usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs: 0,
        calls: 0,
      };
      session.deliverables = [];
      session.status = Status.processing;
      session.currentTool = null;
      session.toolDescription = null;
      const prompt = firstStringFromEvent(event, ['prompt', 'user_prompt', 'userPrompt', 'message', 'content', 'text']);
      if (prompt) {
        session.lastUserPrompt = prompt;
        if (session.recentMessages.at(-1)?.isUser) session.recentMessages.pop();
        addMessage(session, { isUser: true, text: prompt });
      }
      break;
    }
    case 'PreToolUse':
      // Track the real execution regardless of display suppression so the
      // PostToolUse record below always knows which tool just finished.
      startActivity(session, activityKey(event, 'tool'), {
        tool: event.toolName,
        description: event.toolDescription,
      });
      if (!isWaiting) {
        session.status = Status.running;
        session.currentTool = event.toolName;
        session.toolDescription = event.toolDescription;
      }
      break;
    case 'PostToolUse':
      // Carry the tool's output text so the UI can show what actually happened;
      // a successful call also clears any previous failure's error.
      session.lastToolOutput = typeof raw.tool_output === 'string' ? raw.tool_output : null;
      session.lastToolError = null;
      finishActivity(session, event, 'tool', true);
      if (!isWaiting) {
        session.status = session.activeTool ? Status.running : Status.processing;
        session.currentTool = session.activeTool?.tool || null;
        session.toolDescription = session.activeTool?.description || null;
      }
      break;
    case 'PostToolUseFailure':
      session.lastToolError = raw.tool_error || null;
      session.failureCount += 1;
      finishActivity(session, event, 'tool', false);
      if (!isWaiting) {
        session.status = session.activeTool ? Status.running : Status.processing;
        session.currentTool = session.activeTool?.tool || null;
        session.toolDescription = session.activeTool?.description || null;
      }
      break;
    case 'SubagentStart':
      startActivity(session, activityKey(event, 'agent'), {
        tool: 'Agent',
        description: typeof raw.agent_type === 'string' ? raw.agent_type : null,
      });
      if (!isWaiting) {
        session.status = Status.running;
        session.currentTool = 'Agent';
        session.toolDescription = typeof raw.agent_type === 'string' ? raw.agent_type : null;
      }
      break;
    case 'SubagentStop':
      finishActivity(session, event, 'agent', true);
      if (!isWaiting) {
        session.status = session.activeTool ? Status.running : Status.processing;
        session.currentTool = session.activeTool?.tool || null;
        session.toolDescription = session.activeTool?.description || null;
      }
      break;
    case 'Stop': {
      const stopReason = typeof raw.stop_reason === 'string' ? raw.stop_reason : '';
      // flavor-code maps outcome 'cancelled' to stop_reason; a user-interrupt
      // (Ctrl+C) and an explicit cancellation both count as interrupted.
      session.interrupted = stopReason === 'user' || stopReason === 'interrupted' || stopReason === 'cancelled';
      session.status = Status.idle;
      session.currentTool = null;
      session.toolDescription = null;
      // An interrupted tool never sends its Post event — abandon it unrecorded.
      session.activeTool = null;
      session.activeActivities = {};
      session.taskSnapshot = null;
      session.deliverables = Array.isArray(raw.deliverables)
        ? raw.deliverables.filter((item) => item && typeof item.path === 'string').slice(0, 100)
        : session.deliverables;
      const msg = firstStringFromEvent(event, ['last_assistant_message', 'text', 'message', 'summary']);
      if (msg) {
        session.lastAssistantMessage = msg;
        addMessage(session, { isUser: false, text: msg });
      } else if (!session.lastAssistantMessage && session.recentMessages.at(-1)?.isUser) {
        addMessage(session, { isUser: false, text: '[reply complete]' });
      }
      effects.push({ type: 'enqueueCompletion', sessionId });
      break;
    }
    case 'Notification': {
      if (raw.notification_kind === 'task_snapshot'
        && raw.task_snapshot && typeof raw.task_snapshot === 'object') {
        session.taskSnapshot = raw.task_snapshot;
      }
      const text = firstStringFromEvent(event, ['message', 'text', 'summary', 'status', 'detail']);
      if (text) session.toolDescription = text;
      break;
    }
    case 'LoopEnd': {
      // flavor-code also uses LoopEnd for the evolve telemetry service. Only
      // /go terminal events carry the loop_outcome contract rendered here.
      if (typeof raw.loop_outcome !== 'string') break;
      const verification = raw.loop_verification && typeof raw.loop_verification === 'object'
        ? raw.loop_verification : null;
      session.loopOutcome = {
        loopId: typeof raw.loop_id === 'string' ? raw.loop_id : null,
        outcome: typeof raw.loop_outcome === 'string' ? raw.loop_outcome : 'unknown',
        reason: typeof raw.loop_reason === 'string' ? raw.loop_reason : null,
        verification,
      };
      session.status = Status.idle;
      session.currentTool = null;
      session.toolDescription = null;
      break;
    }
    case 'BeforeModelCall': {
      // A model round-trip is the "thinking" phase: processing status with the
      // model id as the description so the pill shows what is being asked. The
      // bridge flattens payload.modelId to `model`; direct `modelId` is kept
      // for other CLIs that don't go through the bridge.
      const modelId = firstStringFromEvent(event, ['model', 'modelId']);
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = modelId ? `Model · ${modelId}` : null;
      }
      if (modelId) session.model = modelId;
      break;
    }
    case 'AfterModelCall':
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      // A provider-side failure (rate limit, network, …) is worth surfacing so
      // the user sees why the agent stalled instead of just "thinking".
      if (raw.providerError === true && typeof raw.errorMessage === 'string') {
        session.lastModelError = raw.errorMessage;
      } else if (raw.providerError === false) {
        session.lastModelError = null;
      }
      session.usage.inputTokens += Number.isFinite(raw.input_tokens) ? Math.max(0, raw.input_tokens) : 0;
      session.usage.outputTokens += Number.isFinite(raw.output_tokens) ? Math.max(0, raw.output_tokens) : 0;
      session.usage.cacheReadTokens += Number.isFinite(raw.cache_read_tokens) ? Math.max(0, raw.cache_read_tokens) : 0;
      session.usage.cacheCreationTokens += Number.isFinite(raw.cache_creation_tokens) ? Math.max(0, raw.cache_creation_tokens) : 0;
      session.usage.durationMs += Number.isFinite(raw.model_duration_ms) ? Math.max(0, raw.model_duration_ms) : 0;
      session.usage.calls += 1;
      break;
    case 'BeforePlan':
      // Planning is a distinct phase from tool execution, so the island can
      // show "Planning…" instead of a generic running/processing state.
      if (!isWaiting) {
        session.status = Status.planning;
        session.currentTool = null;
        session.toolDescription = 'Planning…';
      }
      break;
    case 'AfterPlan':
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    case 'PreCompact':
      session.status = Status.processing;
      session.toolDescription = 'Compacting context…';
      break;
    case 'PostCompact':
      // Recover from the 'Compacting context…' state PreCompact set; without
      // this the description would stick until the next tool event.
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    default:
      break;
  }

  session.lastActivity = Date.now();
  // Quiet mode: ordinary events do not emit sounds. Only blocking events that
  // require a human decision (permission, AskUserQuestion, notification question)
  // play a sound — emitted by appState.requestPermission / requestAskUserQuestion /
  // requestQuestion, not here.
  return { effects };
}

module.exports = { reduceEvent, newSession, Status };
