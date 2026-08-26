'use strict';

// Pure view-model: turns raw session state into the rows the island renders.
// Kept dependency-free so it runs in both Node (tests) and the renderer.

const STATUS_PRIORITY = {
  waitingApproval: 5,
  waitingQuestion: 4,
  running: 3,
  // Planning is a distinct, quieter phase than tool execution: same visual
  // tier as processing (2) so it sorts below running but above idle.
  planning: 2,
  processing: 2,
  idle: 0,
};

function basename(p) {
  if (!p) return null;
  const parts = String(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || null;
}

function statusLabel(session) {
  switch (session.status) {
    case 'waitingApproval':
      return 'Needs approval';
    case 'waitingQuestion':
      return 'Question';
    case 'running':
      return session.currentTool ? `Running · ${session.currentTool}` : 'Running';
    case 'planning':
      return 'Planning…';
    case 'processing':
      return 'Thinking…';
    case 'idle':
    default:
      return 'Idle';
  }
}

function mascotStateFor(status) {
  switch (status) {
    case 'waitingApproval':
    case 'waitingQuestion':
      return 'waiting';
    case 'running':
      return 'running';
    case 'planning':
      // Planning reads like quiet thinking on the pill, not full tool activity.
      return 'processing';
    case 'processing':
      return 'processing';
    default:
      return 'idle';
  }
}

// Tool category color key, mirroring CodeIsland's toolStatusColor accents so
// each tool family reads at a glance (shell green, edit blue, read yellow,
// search purple, agent orange, destructive red).
const TOOL_KEY_MAP = {
  shell: 'shell', bash: 'shell', command: 'shell', exec: 'shell',
  write: 'write', edit: 'write', applypatch: 'write', copy: 'write', mkdir: 'write', registertool: 'write',
  read: 'read', list: 'read', skillresource: 'read', lsphover: 'read', lspdiagnostics: 'read', lspfindrefs: 'read',
  grep: 'search', glob: 'search', search: 'search',
  task: 'agent', agent: 'agent', taskplan: 'agent', taskupdate: 'agent',
  webfetch: 'web', websearch: 'web', fetch: 'web', network: 'web',
  delete: 'destructive', move: 'destructive', removetool: 'destructive',
};

function toolKeyFor(toolName) {
  if (typeof toolName !== 'string' || !toolName) return null;
  if (toolName.startsWith('mcp__')) return 'web';
  return TOOL_KEY_MAP[toolName.toLowerCase()] || 'tool';
}

function titleFor(id, session) {
  return basename(session.cwd) || (typeof id === 'string' ? id.slice(0, 8) : 'session');
}

function taskProgress(snapshot, privateMode = false) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const planTasks = Array.isArray(snapshot.plan?.tasks) ? snapshot.plan.tasks : [];
  const graphNodes = Array.isArray(snapshot.subagents?.graph?.nodes) ? snapshot.subagents.graph.nodes : [];
  const states = snapshot.subagents?.states && typeof snapshot.subagents.states === 'object'
    ? snapshot.subagents.states : {};
  const seen = new Set();
  const tasks = [];
  for (const task of planTasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string') continue;
    seen.add(task.id);
    tasks.push({
      id: task.id,
      label: privateMode ? `Task ${tasks.length + 1}` : (task.subject || task.activeForm || task.id),
      activeForm: privateMode ? `Task ${tasks.length + 1} in progress` : (task.activeForm || task.subject || task.id),
      status: task.status || states[task.id] || 'pending',
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    });
  }
  for (const node of graphNodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || seen.has(node.id)) continue;
    tasks.push({
      id: node.id,
      label: privateMode ? `Task ${tasks.length + 1}` : (node.description || node.id),
      activeForm: privateMode ? `Task ${tasks.length + 1} in progress` : (node.description || node.id),
      status: states[node.id] || 'pending',
      dependencies: Array.isArray(node.dependencies) ? node.dependencies : [],
    });
  }
  if (!tasks.length) return null;
  const activeIndex = tasks.findIndex((task) => task.status === 'in_progress' || task.status === 'running');
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const ordinal = activeIndex >= 0 ? activeIndex + 1 : completed;
  const active = activeIndex >= 0 ? tasks[activeIndex] : null;
  return {
    summary: active
      ? `task ${ordinal}/${tasks.length} · ${active.activeForm}`
      : `${completed}/${tasks.length} tasks complete`,
    tasks,
    completed,
    total: tasks.length,
    active: !!active,
  };
}

function usageModel(usage = {}, pricing = {}) {
  const clean = {
    inputTokens: Math.max(0, Number(usage.inputTokens) || 0),
    outputTokens: Math.max(0, Number(usage.outputTokens) || 0),
    cacheReadTokens: Math.max(0, Number(usage.cacheReadTokens) || 0),
    cacheCreationTokens: Math.max(0, Number(usage.cacheCreationTokens) || 0),
    durationMs: Math.max(0, Number(usage.durationMs) || 0),
    calls: Math.max(0, Number(usage.calls) || 0),
  };
  const cost = (
    clean.inputTokens * (Number(pricing.inputPerMillion) || 0)
    + clean.outputTokens * (Number(pricing.outputPerMillion) || 0)
    + clean.cacheReadTokens * (Number(pricing.cacheReadPerMillion) || 0)
    + clean.cacheCreationTokens * (Number(pricing.cacheCreationPerMillion) || 0)
  ) / 1_000_000;
  return { ...clean, estimatedCost: cost > 0 ? cost : null };
}

function renderModel(state = {}, settings = {}) {
  const sessions = state.sessions || {};
  const entries = Object.entries(sessions);
  const privateMode = settings.privacyMode === true;

  const rows = entries
    .map(([id, session]) => ({
      id,
      source: session.source || 'flavor',
      icon: session.source || 'flavor',
      title: titleFor(id, session),
      statusKey: session.status || 'idle',
      statusLabel: statusLabel(session),
      tool: session.currentTool || null,
      toolKey: toolKeyFor(session.currentTool),
      toolDescription: privateMode
        && session.status !== 'waitingApproval' && session.status !== 'waitingQuestion'
        ? null : (session.toolDescription || null),
      pending: session.status === 'waitingApproval' || session.status === 'waitingQuestion',
      lastActivity: session.lastActivity || 0,
      lastAssistantMessage: privateMode ? null : (session.lastAssistantMessage || null),
      // Detail fields for the expandable row view; all null-safe so sessions
      // that predate these fields (or lack them entirely) render cleanly.
      model: session.model || null,
      failureCount: session.failureCount || 0,
      interrupted: session.interrupted || false,
      lastUserPrompt: privateMode ? null : (session.lastUserPrompt || null),
      lastToolOutput: privateMode ? null : (session.lastToolOutput || null),
      lastToolError: privateMode ? null : (session.lastToolError || null),
      lastModelError: privateMode ? null : (session.lastModelError || null),
      startTime: session.startTime || 0,
      // Compact timeline: newest first, capped at 10 entries so a long session
      // doesn't blow up the detail panel.
      history: (session.history || []).slice(-10).map((item) => privateMode ? { ...item, description: null } : item),
      taskProgress: taskProgress(session.taskSnapshot, privateMode),
      loopOutcome: session.loopOutcome ? {
        ...session.loopOutcome,
        ...(privateMode ? {
          reason: null,
          verification: session.loopOutcome.verification
            ? { passed: session.loopOutcome.verification.passed === true }
            : null,
        } : {}),
      } : null,
      usage: usageModel(session.usage, settings.pricing),
      deliverables: (session.deliverables || []).map((item) => ({
        ...item,
        path: privateMode ? basename(item.path) : item.path,
      })),
      controls: Array.isArray(session.controlCapabilities) ? session.controlCapabilities : [],
      privacyMode: privateMode,
    }))
    .sort((a, b) => {
      const pa = STATUS_PRIORITY[a.statusKey] ?? 1;
      const pb = STATUS_PRIORITY[b.statusKey] ?? 1;
      if (pb !== pa) return pb - pa;
      return b.lastActivity - a.lastActivity;
    });

  const top = rows[0];
  // Quiet mode: the island only expands when a session needs a human decision —
  // authorization (waitingApproval) or information input (waitingQuestion).
  // Ordinary activity (running/processing/idle) is tracked silently and stays
  // collapsed so the island isn't noisy.
  const hasPending = rows.some(
    (r) => r.statusKey === 'waitingApproval' || r.statusKey === 'waitingQuestion'
  );
  const hasProgress = rows.some((r) => r.taskProgress?.active || r.loopOutcome);

  return {
    collapsed: !(hasPending || hasProgress),
    requiresAttention: hasPending,
    suggestsExpanded: hasPending || hasProgress,
    autoExpand: settings.autoExpand !== false,
    privacyMode: privateMode,
    count: rows.length,
    rows,
    // Quiet mode collapses the panel until a decision is pending, but the
    // always-visible pill still reflects the top session's status so the mascot
    // bounces whenever the agent is actively working — running/processing —
    // not only when waiting for the user.
    mascotState: top ? mascotStateFor(top.statusKey) : 'idle',
  };
}

module.exports = { renderModel, STATUS_PRIORITY, toolKeyFor };
