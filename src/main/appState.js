'use strict';

const { reduceEvent, Status } = require('../core/sessionStore');
const { parseQuestions, buildAllowResponse, buildDenyResponse } = require('../core/askQuestion');

// Main-process application state: owns the session map, applies the pure
// reducer, and brokers blocking permission/question requests between the
// hook server (which awaits a decision) and the UI (which produces one).
function createAppState() {
  const sessions = {};
  const subscribers = new Set();
  // key -> { resolve, event, sessionId, kind }
  const pending = new Map();
  // dedupeKey -> { promise, decision, at }. Two plugin tiers can both relay
  // the same hook event (the baked-in `codeisland` plugin from `flavor init`
  // plus the global `flavor-island` plugin), so one user action may arrive
  // twice — in flight or back-to-back. This cache makes duplicates share the
  // primary request's outcome instead of spawning a second card.
  const recentDecisions = new Map();
  const RECENT_DECISION_TTL_MS = 30_000;
  let seq = 0;

  function notify(effects = []) {
    for (const fn of subscribers) {
      try { fn({ sessions }, effects); } catch { /* a flaky listener must not break state */ }
    }
  }

  function applyEffects(effects) {
    for (const e of effects) {
      if (e.type === 'removeSession') {
        denyPendingForSession(e.sessionId);
        delete sessions[e.sessionId];
      }
    }
    pruneRecentDecisions();
  }

  function denyPendingForSession(sessionId) {
    for (const [key, entry] of pending) {
      if (entry.sessionId === sessionId) {
        const value = denyValueFor(entry.kind);
        if ((entry.kind === 'permission' || entry.kind === 'askUserQuestion') && entry.dedupeKey) {
          recentDecisions.set(entry.dedupeKey, { decision: value, at: Date.now() });
        }
        entry.resolve(value);
        pending.delete(key);
      }
    }
  }

  // The "abandon" value differs per pending kind: permission expects 'deny',
  // AskUserQuestion expects a full PermissionRequest deny object, and a plain
  // notification question expects null.
  function denyValueFor(kind) {
    if (kind === 'permission') return 'deny';
    if (kind === 'askUserQuestion') return buildDenyResponse();
    return null;
  }

  function handleEvent(event) {
    const { effects } = reduceEvent(sessions, event);
    applyEffects(effects);
    notify(effects);
  }

  function ensureSession(sessionId) {
    if (!sessions[sessionId]) {
      reduceEvent(sessions, { eventName: 'SessionStart', sessionId, rawJSON: {} });
    }
  }

  // Stable identity for a permission request: two relays of the same hook
  // event carry identical session/tool/input, while genuinely separate calls
  // almost always differ in tool_input.
  function permissionDedupeKey(event) {
    let input = '';
    try { input = JSON.stringify(event.toolInput || null); } catch { input = ''; }
    return [
      event.sessionId || 'default',
      event.toolName || '',
      event.toolDescription || '',
      input,
    ].join('\u0001');
  }

  function pruneRecentDecisions(now = Date.now()) {
    for (const [key, entry] of recentDecisions) {
      if (now - entry.at > RECENT_DECISION_TTL_MS) recentDecisions.delete(key);
    }
  }

  function requestPermission(event) {
    const sessionId = event.sessionId || 'default';
    ensureSession(sessionId);

    const dedupeKey = permissionDedupeKey(event);
    // Duplicate while the primary is still waiting -> share its promise so
    // both relay sockets get the same decision from one card.
    for (const entry of pending.values()) {
      if (entry.kind === 'permission' && entry.dedupeKey === dedupeKey) return entry.promise;
    }
    // Duplicate arriving right after the primary resolved (the second plugin's
    // relay runs sequentially after the first) -> replay the decision.
    pruneRecentDecisions();
    const recent = recentDecisions.get(dedupeKey);
    if (recent) return Promise.resolve(recent.decision);

    const s = sessions[sessionId];
    s.status = Status.waitingApproval;
    s.currentTool = event.toolName || s.currentTool;
    s.toolDescription = event.toolDescription || s.toolDescription;
    s.lastActivity = Date.now();

    const key = `perm-${++seq}`;
    const promise = new Promise((resolve) => {
      pending.set(key, { resolve, event, sessionId, kind: 'permission', dedupeKey });
    });
    pending.get(key).promise = promise;
    notify([{ type: 'playSound', event: 'PermissionRequest' }]);
    return promise;
  }

  function requestQuestion(event) {
    const sessionId = event.sessionId || 'default';
    ensureSession(sessionId);
    const s = sessions[sessionId];
    s.status = Status.waitingQuestion;
    s.toolDescription = event.toolDescription || s.toolDescription;
    s.lastActivity = Date.now();

    const key = `ques-${++seq}`;
    const promise = new Promise((resolve) => {
      pending.set(key, { resolve, event, sessionId, kind: 'question' });
    });
    notify([{ type: 'playSound', event: 'Notification' }]);
    return promise;
  }

  // AskUserQuestion (flavor-code's select/type tool). Parses the questions,
  // blocks until the UI submits answers, and resolves with the full hook
  // response object the server writes back. Empty question lists auto-allow so
  // the agent is never wedged on a prompt with nothing to answer. Two plugin
  // tiers can relay the same question (global flavor-island plus the baked-in
  // codeisland plugin), so duplicate relays share one card's promise while it
  // waits and replay the resolved response afterwards.
  function requestAskUserQuestion(event) {
    const sessionId = event.sessionId || 'default';
    ensureSession(sessionId);
    const questions = parseQuestions(event);

    if (!questions.length) {
      return Promise.resolve(buildAllowResponse(event, {}));
    }

    const dedupeKey = permissionDedupeKey(event);
    for (const entry of pending.values()) {
      if (entry.kind === 'askUserQuestion' && entry.dedupeKey === dedupeKey) return entry.promise;
    }
    pruneRecentDecisions();
    const recent = recentDecisions.get(dedupeKey);
    if (recent) return Promise.resolve(recent.decision);

    const s = sessions[sessionId];
    s.status = Status.waitingQuestion;
    s.toolDescription = questions[0].question || s.toolDescription;
    s.lastActivity = Date.now();

    const key = `ask-${++seq}`;
    const promise = new Promise((resolve) => {
      pending.set(key, { resolve, event, sessionId, kind: 'askUserQuestion', questions, dedupeKey });
    });
    pending.get(key).promise = promise;
    notify([{ type: 'playSound', event: 'PermissionRequest' }]);
    return promise;
  }

  // answers: { [questionText]: answerString }. Multi-select answers are
  // pre-joined by the UI before they reach here. details: { [questionText]:
  // { checked, text } } carries each question's custom-input checkbox state and
  // text so the submitted data contains both.
  function resolveAskUserQuestion(key, answers, details) {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    clearWaitingQuestion(entry.sessionId);
    const response = buildAllowResponse(entry.event, answers || {}, details || {});
    if (entry.dedupeKey) {
      recentDecisions.set(entry.dedupeKey, { decision: response, at: Date.now() });
    }
    entry.resolve(response);
    notify();
    return true;
  }

  function skipAskUserQuestion(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    clearWaitingQuestion(entry.sessionId);
    const response = buildDenyResponse();
    if (entry.dedupeKey) {
      recentDecisions.set(entry.dedupeKey, { decision: response, at: Date.now() });
    }
    entry.resolve(response);
    notify();
    return true;
  }

  function clearWaitingQuestion(sessionId) {
    const s = sessions[sessionId];
    if (s && s.status === Status.waitingQuestion && !hasPendingForSession(sessionId)) {
      s.status = Status.processing;
      s.currentTool = null;
      s.toolDescription = null;
    }
  }

  function resolvePermission(key, behavior) {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    // Move the session out of the waiting state if nothing else is pending for it.
    const s = sessions[entry.sessionId];
    if (s && s.status === Status.waitingApproval && !hasPendingForSession(entry.sessionId)) {
      s.status = Status.processing;
      s.currentTool = null;
      s.toolDescription = null;
    }
    // Pass the decision through verbatim: 'deny', 'allow', or 'allowAll' (allow
    // this call and persist a same-tool session rule). The hook server turns it
    // into the right PermissionRequest response. Anything unexpected falls back
    // to a plain allow.
    const decision = behavior === 'deny' || behavior === 'allowAll' ? behavior : 'allow';
    if (entry.kind === 'permission' && entry.dedupeKey) {
      recentDecisions.set(entry.dedupeKey, { decision, at: Date.now() });
    }
    entry.resolve(decision);
    notify();
    return true;
  }

  function resolveQuestion(key, answer) {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    const s = sessions[entry.sessionId];
    if (s && s.status === Status.waitingQuestion && !hasPendingForSession(entry.sessionId)) {
      s.status = Status.processing;
    }
    entry.resolve(answer ?? null);
    notify();
    return true;
  }

  function hasPendingForSession(sessionId) {
    for (const entry of pending.values()) if (entry.sessionId === sessionId) return true;
    return false;
  }

  function listPending() {
    return [...pending.entries()].map(([key, e]) => ({
      key,
      sessionId: e.sessionId,
      kind: e.kind,
      toolName: e.event.toolName || null,
      toolDescription: e.event.toolDescription || null,
      questions: e.questions || null,
    }));
  }

  // Drop sessions that have been idle for longer than maxIdleMs.
  function cleanupIdle(maxIdleMs = 5 * 60 * 1000, now = Date.now()) {
    let changed = false;
    for (const [id, s] of Object.entries(sessions)) {
      if (s.status === Status.idle && now - (s.lastActivity || 0) > maxIdleMs) {
        delete sessions[id];
        changed = true;
      }
    }
    if (changed) notify();
  }

  return {
    handleEvent,
    requestPermission,
    requestQuestion,
    requestAskUserQuestion,
    resolvePermission,
    resolveQuestion,
    resolveAskUserQuestion,
    skipAskUserQuestion,
    listPending,
    cleanupIdle,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    snapshot() { return { sessions }; },
  };
}

module.exports = { createAppState };
