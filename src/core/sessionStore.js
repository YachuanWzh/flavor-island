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
    currentTool: null,
    toolDescription: null,
    // The tool actually executing, independent of what the island displays
    // (the display layer debounces currentTool; history must not).
    activeTool: null,
    lastUserPrompt: null,
    lastAssistantMessage: null,
    lastToolOutput: null,
    lastToolError: null,
    failureCount: 0,
    lastModelError: null,
    interrupted: false,
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

function applyMetadata(session, raw) {
  if (typeof raw._source === 'string' && raw._source) session.source = raw._source;
  if (typeof raw.cwd === 'string' && raw.cwd) session.cwd = raw.cwd;
  if (typeof raw.model === 'string' && raw.model) session.model = raw.model;
  if (typeof raw._ppid === 'number' && raw._ppid > 0) session.cliPid = raw._ppid;
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
      session.activeTool = { tool: event.toolName, description: event.toolDescription };
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
      if (session.activeTool) recordTool(session, session.activeTool.tool, session.activeTool.description, true);
      session.activeTool = null;
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    case 'PostToolUseFailure':
      session.lastToolError = raw.tool_error || null;
      session.failureCount += 1;
      if (session.activeTool) recordTool(session, session.activeTool.tool, session.activeTool.description, false);
      session.activeTool = null;
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    case 'SubagentStart':
      session.activeTool = { tool: 'Agent', description: typeof raw.agent_type === 'string' ? raw.agent_type : null };
      if (!isWaiting) {
        session.status = Status.running;
        session.currentTool = 'Agent';
        session.toolDescription = typeof raw.agent_type === 'string' ? raw.agent_type : null;
      }
      break;
    case 'SubagentStop':
      if (session.activeTool) recordTool(session, session.activeTool.tool, session.activeTool.description, true);
      session.activeTool = null;
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
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
      const text = firstStringFromEvent(event, ['message', 'text', 'summary', 'status', 'detail']);
      if (text) session.toolDescription = text;
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
      }
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
