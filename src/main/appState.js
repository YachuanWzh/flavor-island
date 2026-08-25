'use strict';

const { reduceEvent, Status } = require('../core/sessionStore');
const { parseQuestions, buildAllowResponse, buildDenyResponse } = require('../core/askQuestion');

// Tool-display smoothing: fast tool calls (quick reads, greps, …) must not
// flash through the pill. The reducer keeps recording every tool faithfully
// (status + history); this layer only governs what the island *shows*:
//   reveal delay — a tool only appears after running TOOL_REVEAL_DELAY_MS, so
//                  calls that finish sooner never touch the UI at all (this
//                  holds even while another tool chip is still on screen, so
//                  rapid back-to-back tools can't strobe the pill text);
//   min hold     — once shown, the chip stays at least TOOL_MIN_HOLD_MS; when
//                  it finally drops, a tool that queued up meanwhile is then
//                  revealed through the same reveal delay.
const TOOL_REVEAL_DELAY_MS = 300;
const TOOL_MIN_HOLD_MS = 800;

// Main-process application state: owns the session map, applies the pure
// reducer, and brokers blocking permission/question requests between the
// hook server (which awaits a decision) and the UI (which produces one).
function createAppState(options = {}) {
  // Injectable clock so the display scheduler is testable without real waits.
  // delay(fn, ms) must return a handle exposing clear().
  const now = options.now || Date.now;
  const delay = options.delay || ((fn, ms) => {
    const t = setTimeout(fn, ms);
    return { clear: () => clearTimeout(t) };
  });
  const sessions = {};
  const subscribers = new Set();
  // key -> { resolve, event, sessionId, kind }
  const pending = new Map();
  // dedupeKey -> { promise, decision, at }. The global `flavor-island` plugin
  // is the only relay today (the baked-in `codeisland` plugin was removed from
  // flavor-code), but a user can still end up with a stale copy in their
  // ~/.flavor-code/plugins dir — or run the island while an old flavor-code
  // session is alive — so one user action can still arrive twice, in flight
  // or back-to-back. This cache makes duplicates share the primary request's
  // outcome instead of spawning a second card.
  const recentDecisions = new Map();
  const RECENT_DECISION_TTL_MS = 30_000;
  // sessionId -> Set of tool names the user "Allow all"-ed this session.
  // flavor-code only records the rule in its own process, and every later
  // call is still relayed here — so the island keeps its own copy and
  // auto-approves matching calls instead of showing a card each time.
  const allowAllRules = new Map();
  // sessionId -> tool-display scheduler state (see the smoothing block above).
  const toolDisplay = new Map();
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
        allowAllRules.delete(e.sessionId);
        // Session-scoped state dies with the session: drop replay cache
        // entries that belong to it (dedupe keys are prefixed by session id).
        for (const [key, entry] of recentDecisions) {
          if (key.startsWith(`${e.sessionId}\u0001`) || key === e.sessionId) recentDecisions.delete(key);
        }
        dropToolDisplay(e.sessionId);
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
    // The reducer already cleared currentTool for a finished tool; the display
    // scheduler decides what the pill keeps showing (debounce + min hold).
    const name = event && event.eventName;
    if (name === 'PreToolUse' || name === 'SubagentStart') {
      startToolDisplay(event);
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure' || name === 'SubagentStop') {
      endToolDisplay(event);
    } else if (name === 'Stop') {
      // Turn over: drop any half-revealed tool so the next turn starts clean
      // (an interrupted tool never sends its Post event).
      const sessionId = event.sessionId || 'default';
      const d = toolDisplay.get(sessionId);
      if (d) {
        if (d.revealTimer) { d.revealTimer.clear(); d.revealTimer = null; }
        if (d.holdTimer) { d.holdTimer.clear(); d.holdTimer = null; }
        d.shown = null;
        d.pending = null;
      }
    }
    notify(effects);
  }

  function displayFor(sessionId) {
    if (!toolDisplay.has(sessionId)) {
      toolDisplay.set(sessionId, {
        revealTimer: null,
        holdTimer: null,
        shown: null,     // { tool, description } currently surfaced to the UI
        shownAt: 0,
        pending: null,   // latest tool waiting out the reveal delay
      });
    }
    return toolDisplay.get(sessionId);
  }

  function dropToolDisplay(sessionId) {
    const d = toolDisplay.get(sessionId);
    if (!d) return;
    if (d.revealTimer) d.revealTimer.clear();
    if (d.holdTimer) d.holdTimer.clear();
    toolDisplay.delete(sessionId);
  }

  function startToolDisplay(event) {
    const sessionId = event.sessionId || 'default';
    const session = sessions[sessionId];
    if (!session) return;
    const d = displayFor(sessionId);
    const tool = event.toolName || null;
    const description = event.toolDescription || null;
    // Queue for reveal. A newer tool always supersedes the pending one — the
    // pill shows what's actually running, never a stale intermediate.
    d.pending = { tool, description };
    if (d.shown) {
      // A chip is already on screen (min hold still running): the reducer just
      // overwrote currentTool with the newcomer — restore the displayed tool
      // so the pill stays stable until the hold expires.
      applyToolDisplay(session, sessionId);
    } else {
      // Nothing displayed: take the reducer's currentTool off the session so
      // nothing reaches the pill until the reveal delay elapses. (Both happen
      // inside one handleEvent, before the single notify at the end — no flash.)
      session.currentTool = null;
      session.toolDescription = null;
      scheduleReveal(sessionId);
    }
  }

  function scheduleReveal(sessionId) {
    const d = displayFor(sessionId);
    if (d.revealTimer || !d.pending) return;
    d.revealTimer = delay(() => {
      d.revealTimer = null;
      revealPending(sessionId);
    }, TOOL_REVEAL_DELAY_MS);
  }

  function revealPending(sessionId) {
    const s = sessions[sessionId];
    const d = toolDisplay.get(sessionId);
    if (!s || !d || !d.pending) return;
    // The session may have moved on (Stop/SessionEnd) while the reveal waited;
    // never resurrect a finished session into "running".
    if (s.status !== Status.running && s.status !== Status.processing && s.status !== Status.planning) {
      // A waiting session is different: the tool is gated behind an approval
      // card and only *starts* once the user decides. Keep the pending tool
      // and let the waiting-state resolution re-arm the reveal.
      if (s.status === Status.waitingApproval || s.status === Status.waitingQuestion) return;
      d.pending = null;
      return;
    }
    d.shown = d.pending;
    d.pending = null;
    d.shownAt = now();
    applyToolDisplay(s, sessionId);
  }

  // Push the scheduler's chosen tool into the session for rendering. Status is
  // only forced to running from quiet phases — never over a waiting state —
  // and dropping the last chip returns "running" to plain "processing".
  function applyToolDisplay(session, sessionId) {
    const d = displayFor(sessionId);
    session.currentTool = d.shown ? d.shown.tool : null;
    session.toolDescription = d.shown ? d.shown.description : null;
    if (d.shown) {
      if (session.status !== Status.waitingApproval && session.status !== Status.waitingQuestion) {
        session.status = Status.running;
      }
    } else if (session.status === Status.running) {
      session.status = Status.processing;
    }
    session.lastActivity = now();
    notify();
  }

  // A waiting state (approval/question card) just cleared and the session is
  // active again. If a tool is still gated behind its reveal delay — typically
  // the permission-gated tool whose Pre arrived before the card — re-arm the
  // reveal so it surfaces once it actually starts running.
  function resumeToolReveal(sessionId) {
    const d = toolDisplay.get(sessionId);
    if (d && d.pending && !d.shown) scheduleReveal(sessionId);
  }

  // Hook events alternate strictly Pre→Post per session, so the event ending
  // now is the newest one started: it is `pending` when set, otherwise `shown`.
  function endToolDisplay(event) {
    const sessionId = event.sessionId || 'default';
    const session = sessions[sessionId];
    const d = toolDisplay.get(sessionId);
    if (!session || !d) return;
    session.lastActivity = now();
    // History recording is the reducer's job (via session.activeTool) — this
    // layer only decides what the pill keeps showing.
    if (d.pending) {
      // Finished before (or while waiting out) the reveal delay: silently drop
      // it — the pill never knew about this call.
      if (d.revealTimer) { d.revealTimer.clear(); d.revealTimer = null; }
      d.pending = null;
      return;
    }
    if (!d.shown) return;
    const held = now() - d.shownAt;
    if (held >= TOOL_MIN_HOLD_MS) {
      // Shown long enough — drop it now, then give any queued tool its own
      // reveal delay instead of flashing it in immediately.
      d.shown = null;
      applyToolDisplay(session, sessionId);
      scheduleReveal(sessionId);
    } else if (!d.holdTimer) {
      // Too quick to drop: the reducer already cleared currentTool — re-apply
      // the chip so it stays on screen for the remainder of the min hold.
      applyToolDisplay(session, sessionId);
      // When the hold expires, clear it — and reveal any tool that queued up
      // meanwhile.
      d.holdTimer = delay(() => {
        d.holdTimer = null;
        const s = sessions[sessionId];
        if (!s || !d.shown) return;
        if (s.status === Status.waitingApproval || s.status === Status.waitingQuestion) return;
        if (s.status !== Status.running && s.status !== Status.processing) return;
        d.shown = null;
        applyToolDisplay(s, sessionId);
        scheduleReveal(sessionId);
      }, TOOL_MIN_HOLD_MS - held);
    }
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

    // "Allow all" already granted for this tool in this session -> approve
    // silently without surfacing a card.
    if (allowAllRules.get(sessionId)?.has(event.toolName || '')) {
      return Promise.resolve('allow');
    }

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
      resumeToolReveal(sessionId);
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
    // this call and record a same-tool session rule so later calls of that
    // tool auto-approve). The hook server turns it into the right
    // PermissionRequest response. Anything unexpected falls back to a plain
    // allow.
    const decision = behavior === 'deny' || behavior === 'allowAll' ? behavior : 'allow';
    if (decision === 'deny') {
      // A denied tool never runs — forget its pending chip entirely.
      const d = toolDisplay.get(entry.sessionId);
      if (d && d.pending) {
        if (d.revealTimer) { d.revealTimer.clear(); d.revealTimer = null; }
        d.pending = null;
      }
    } else {
      // Allowed: the tool starts executing now — re-arm its reveal.
      resumeToolReveal(entry.sessionId);
    }
    if (decision === 'allowAll' && entry.event.toolName) {
      if (!allowAllRules.has(entry.sessionId)) allowAllRules.set(entry.sessionId, new Set());
      allowAllRules.get(entry.sessionId).add(entry.event.toolName);
    }
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
      resumeToolReveal(entry.sessionId);
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
