'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SESSIONS = 100;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function cachedSession(session) {
  return {
    cwd: typeof session.cwd === 'string' ? session.cwd.slice(0, 1000) : null,
    title: typeof session.title === 'string' ? session.title.slice(0, 120) : null,
    source: typeof session.source === 'string' ? session.source : null,
    model: typeof session.model === 'string' ? session.model.slice(0, 120) : null,
    cliPid: Number.isSafeInteger(session.cliPid) ? session.cliPid : null,
    // A live PID does not prove that an earlier task is still running. A Stop
    // event may have been missed while Island was closed; wait for a fresh hook
    // before marking a restored session active again.
    status: 'idle',
    currentTool: null,
    toolDescription: null,
    startTime: Number.isFinite(session.startTime) ? session.startTime : Date.now(),
    lastActivity: Number.isFinite(session.lastActivity) ? session.lastActivity : Date.now(),
    controlCapabilities: [],
    history: [],
    recentMessages: [],
    activeActivities: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0, calls: 0 },
    deliverables: [],
  };
}

function loadSessionCache(file, { now = Date.now(), isAlive = livePid } = {}) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const sessions = {};
  for (const [id, session] of Object.entries(stored).slice(0, MAX_SESSIONS)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !session || typeof session !== 'object') continue;
    if (!isAlive(session.cliPid) || !Number.isFinite(session.lastActivity)
      || now - session.lastActivity > MAX_AGE_MS || session.lastActivity > now + 60_000) continue;
    sessions[id] = cachedSession(session);
  }
  return sessions;
}

function saveSessionCache(file, sessions) {
  const snapshot = {};
  for (const [id, session] of Object.entries(sessions || {}).slice(0, MAX_SESSIONS)) {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) snapshot[id] = cachedSession(session);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

module.exports = { loadSessionCache, saveSessionCache };
