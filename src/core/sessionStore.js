'use strict';

const { normalize } = require('./eventNormalizer');

// Status values mirror CodeIsland's AgentStatus.
const Status = {
  idle: 'idle',
  processing: 'processing',
  running: 'running',
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
    lastUserPrompt: null,
    lastAssistantMessage: null,
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
      if (!isWaiting) {
        session.status = Status.running;
        session.currentTool = event.toolName;
        session.toolDescription = event.toolDescription;
      }
      break;
    case 'PostToolUse':
      if (session.currentTool) recordTool(session, session.currentTool, session.toolDescription, true);
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    case 'PostToolUseFailure':
      if (session.currentTool) recordTool(session, session.currentTool, session.toolDescription, false);
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    case 'SubagentStart':
      if (!isWaiting) {
        session.status = Status.running;
        session.currentTool = 'Agent';
        session.toolDescription = typeof raw.agent_type === 'string' ? raw.agent_type : null;
      }
      break;
    case 'SubagentStop':
      if (!isWaiting) {
        session.status = Status.processing;
        session.currentTool = null;
        session.toolDescription = null;
      }
      break;
    case 'Stop': {
      const stopReason = typeof raw.stop_reason === 'string' ? raw.stop_reason : '';
      session.interrupted = stopReason === 'user' || stopReason === 'interrupted';
      session.status = Status.idle;
      session.currentTool = null;
      session.toolDescription = null;
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
    case 'PreCompact':
      session.status = Status.processing;
      session.toolDescription = 'Compacting context…';
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
