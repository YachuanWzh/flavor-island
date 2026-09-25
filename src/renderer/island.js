'use strict';

// Renderer: receives state pushes from main, renders the island, plays sounds,
// and sends permission decisions back. renderModel already did the heavy lifting
// in the main process, so this stays a thin DOM layer.

const islandEl = document.getElementById('island');
const pillEl = document.getElementById('pill');
const pillStatusEl = document.getElementById('pill-status');
const pillCountEl = document.getElementById('pill-count');
const pillAlertEl = document.getElementById('pill-alert');
const panelEl = document.getElementById('panel');

// Canvas pixel mascot (sleep / typing / startled scenes, see mascot.js).
const mascot = createMascot(document.getElementById('mascot'));
mascot.start();

// Honor the OS reduced-motion setting for the pill width tween too (the CSS
// media query already flattens stylesheet animations).
const SYSTEM_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let reducedMotion = SYSTEM_REDUCED_MOTION;

// Vertical room reserved below the content so the drop shadow renders fully
// instead of being clipped into a hard line by body{overflow:hidden}.
const SHADOW_PAD = 28;

const SOUND_MAP = {
  SessionStart: '8bit_boot',
  UserPromptSubmit: '8bit_submit',
  PreToolUse: '8bit_start',
  PermissionRequest: '8bit_approval',
  Notification: '8bit_approval',
  Stop: '8bit_complete',
  PostToolUseFailure: '8bit_error',
};
const audioCache = {};
let lastSoundAt = 0;

function playSound(name) {
  const file = SOUND_MAP[name];
  if (!file) return;
  const now = Date.now();
  if (now - lastSoundAt < 120) return; // throttle bursts
  lastSoundAt = now;
  try {
    const a = audioCache[file] || (audioCache[file] = new Audio(`../assets/sounds/${file}.wav`));
    a.currentTime = 0;
    a.volume = 0.5;
    a.play().catch(() => {});
  } catch { /* ignore */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pendingForSession(pending, sessionId) {
  return pending.find((p) => p.sessionId === sessionId) || null;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function fmtTokens(value) {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
}

// Build the expandable detail block for one row. Only non-empty fields are
// emitted (empty sessions get a quiet placeholder); all text passes through
// escapeHtml because history descriptions come straight from tool inputs.
function buildRowDetail(row) {
  const parts = [];
  const scrollBlock = (text) => `<div class="detail-scroll">${escapeHtml(text)}</div>`;
  const addRow = (label, valueHtml, extra = '') => {
    parts.push(`<div class="detail-row ${extra}"><span class="detail-label">${label}</span>${valueHtml}</div>`);
  };

  if (row.model) addRow('Model', `<span class="detail-value">${escapeHtml(row.model)}</span>`);
  if (row.usage && row.usage.calls > 0) {
    const usage = `${fmtTokens(row.usage.inputTokens)} in · ${fmtTokens(row.usage.outputTokens)} out`
      + ` · cache ${fmtTokens(row.usage.cacheReadTokens)}/${fmtTokens(row.usage.cacheCreationTokens)}`
      + ` · avg ${(row.usage.durationMs / Math.max(1, row.usage.calls) / 1000).toFixed(1)}s`
      + (row.usage.estimatedCost == null ? '' : ` · $${row.usage.estimatedCost.toFixed(4)}`);
    addRow('Usage', `<span class="detail-value">${escapeHtml(usage)}</span>`);
  }
  if (row.startTime) {
    addRow('Running', `<span class="detail-value detail-duration" data-start-time="${row.startTime}">${fmtDuration(Date.now() - row.startTime)}</span>`);
  }
  if (row.lastUserPrompt) addRow('Prompt', scrollBlock(row.lastUserPrompt));
  if (row.lastAssistantMessage) addRow('Reply', scrollBlock(row.lastAssistantMessage));
  if (row.lastToolError) addRow('Last error', scrollBlock(row.lastToolError), 'detail-error');
  if (row.lastModelError) addRow('Model error', scrollBlock(row.lastModelError), 'detail-error');
  // Safety net: even though the bridge truncates tool output, never render
  // more than 2000 chars of it into the detail panel.
  if (row.lastToolOutput) {
    addRow('Last output', `<div class="detail-scroll detail-pre">${escapeHtml(String(row.lastToolOutput).slice(0, 2000))}</div>`);
  }
  if (row.privacyMode) addRow('Privacy', '<span class="badge badge-private">Sensitive details hidden</span>');

  if (row.deliverables && row.deliverables.length) {
    const files = row.deliverables.map((file) => `<div class="deliverable"><span>${escapeHtml(file.operation || 'update')}</span>`
      + `<b title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</b>`
      + `<em>+${Number(file.added) || 0} −${Number(file.removed) || 0}</em></div>`).join('');
    addRow('Deliverables', `<div class="deliverables">${files}</div>`);
  }

  const badges = [];
  if (row.failureCount > 0) badges.push(`<span class="badge badge-fail">Failures: ${row.failureCount}</span>`);
  if (row.interrupted) badges.push(`<span class="badge badge-int">Interrupted</span>`);
  if (badges.length) parts.push(`<div class="detail-badges">${badges.join('')}</div>`);

  if (row.history && row.history.length) {
    // Newest first: the timeline reads top-down as "what just happened".
    const lines = row.history.slice().reverse().map((h) => {
      const desc = h.description ? ` · ${h.description}` : '';
      return `<div class="hist-line ${h.success ? 'hist-ok' : 'hist-fail'}">`
        + `<span class="hist-mark">${h.success ? '✓' : '✗'}</span>`
        + `<span class="hist-body" title="${escapeHtml(h.description || '')}">${escapeHtml(h.tool)}${escapeHtml(desc)}</span>`
        + `<span class="hist-time">${fmtTime(h.timestamp)}</span></div>`;
    }).join('');
    parts.push(`<div class="detail-row"><span class="detail-label">History</span><div class="detail-history">${lines}</div></div>`);
  }

  if (!parts.length) return '<div class="detail-empty">No details yet</div>';
  return parts.join('');
}

function ensureDurationTimer() {
  if (durationTimer) return;
  // Refresh only the duration line in place; a full re-render on a timer would
  // fight the settled-signature animation suppression and the resize loop.
  durationTimer = setInterval(() => {
    const el = document.querySelector('.detail-duration');
    if (el && el.dataset.startTime) el.textContent = fmtDuration(Date.now() - Number(el.dataset.startTime));
  }, 30_000);
}

// Draft answers for in-flight AskUserQuestion cards, keyed by pending key, so the
// user's selections survive the periodic state re-renders. Each draft is an array
// (one entry per question): { value, set: string[], other, otherText }.
const askDrafts = new Map();

// Last size sent to main for a window resize — guards against no-op resizes.
// lastResizeW stays null on the pill layout, where main owns the width.
let lastResizeH = 0;
let lastResizeW = null;

// Expandable session details: at most one row's detail block is open, keyed by
// row id. Main knows nothing about this state — the renderer re-applies it on
// every state push by re-rendering the open block.
let openDetailId = null;
// Row-id set from the previous render; when the set changes (a session appears
// or disappears) the open detail no longer maps to a real row, so reset it.
let lastRowSet = '';
// The most recent state push, kept so a detail toggle can re-render the panel
// without waiting for the next push from main.
let lastRenderState = null;
// null follows the view-model suggestion; true/false is the user's manual
// panel preference. A blocking approval/question always wins and expands.
let manualPanelOpen = null;
// One shared timer refreshes the "Running Xm Ys" line while a detail is open —
// state pushes alone are too sparse to make the duration tick.
let durationTimer = null;

function draftFor(pend) {
  let d = askDrafts.get(pend.key);
  if (!d || d.length !== pend.questions.length) {
    d = pend.questions.map(() => ({ value: null, set: [], other: false, otherText: '' }));
    askDrafts.set(pend.key, d);
  }
  return d;
}

// answerForQuestion / allQuestionsAnswered / buildAskPayload live in askDraft.js
// (loaded before this file) so the pure composition logic is unit-testable.

function buildAskCard(div, pend) {
  const draft = draftFor(pend);

  let submitBtn = null;
  // Selection changes patch the card in place: a full panel rebuild on every
  // click restarts the row-in animation and re-applies the window bounds,
  // which reads as a visible flash on the transparent window.
  const refreshSubmit = () => {
    if (submitBtn) submitBtn.disabled = !allQuestionsAnswered(pend.questions, draft);
  };

  pend.questions.forEach((q, qi) => {
    const qd = draft[qi];
    const qEl = document.createElement('div');
    qEl.className = 'question';
    if (q.header) {
      const h = document.createElement('div');
      h.className = 'q-header';
      h.textContent = q.header;
      qEl.appendChild(h);
    }
    const t = document.createElement('div');
    t.className = 'q-text';
    t.textContent = q.question;
    qEl.appendChild(t);

    const hasOptions = q.options && q.options.length;
    if (hasOptions) {
      const opts = document.createElement('div');
      opts.className = 'q-options';
      let customEl = null;
      const rows = q.options.map((opt) => {
        const isSelected = () => (q.multiSelect
          ? qd.set.includes(opt.label)
          : (!qd.other && qd.value === opt.label));
        const row = optionRow(opt.label, opt.description, q.multiSelect, isSelected());
        row.onclick = () => {
          if (q.multiSelect) {
            const i = qd.set.indexOf(opt.label);
            if (i >= 0) qd.set.splice(i, 1); else qd.set.push(opt.label);
          } else {
            qd.value = opt.label;
            qd.other = false;
            if (customEl) setCustomChecked(customEl, false);
          }
          refreshRows();
          refreshSubmit();
        };
        return { row, isSelected };
      });
      const refreshRows = () => rows.forEach(({ row, isSelected }) => {
        const selected = isSelected();
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-selected', String(selected));
      });
      rows.forEach(({ row }) => opts.appendChild(row));
      qEl.appendChild(opts);
      // Final custom-input item: a single horizontal row with a checkbox on the
      // left and a single-line input on the right. The two controls are
      // independent — toggling the checkbox never clears typed text.
      customEl = customRow(q, qd, () => {
        if (!q.multiSelect) refreshRows();
        refreshSubmit();
      });
      qEl.appendChild(customEl);
    } else {
      // Text-only question.
      qEl.appendChild(textInput(qd, refreshSubmit));
    }
    div.appendChild(qEl);
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  const skip = document.createElement('button');
  skip.className = 'btn btn-skip';
  skip.textContent = '跳过';
  skip.onclick = () => { askDrafts.delete(pend.key); window.flavorIsland.skipQuestions(pend.key); };
  submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-submit';
  submitBtn.textContent = '提交';
  submitBtn.onclick = () => {
    if (submitBtn.disabled) return;
    // Payload carries the answer strings (unchanged contract) plus, per
    // question, the custom-input checkbox state and its text together.
    const { answers, details } = buildAskPayload(pend.questions, draft);
    askDrafts.delete(pend.key);
    window.flavorIsland.answerQuestions(pend.key, answers, details);
  };
  div.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (!event.target.matches('.q-input')) return;
    event.preventDefault();
    refreshSubmit();
    if (!submitBtn.disabled) submitBtn.click();
  });
  refreshSubmit();
  actions.append(skip, submitBtn);
  div.appendChild(actions);
}

function buildPlainQuestionCard(div, pend) {
  const question = document.createElement('div');
  question.className = 'question';
  const text = document.createElement('div');
  text.className = 'q-text';
  text.textContent = pend.question || 'Continue?';
  question.appendChild(text);
  const options = (Array.isArray(pend.options) ? pend.options : []).filter((option) => {
    const label = typeof option === 'string' ? option : option?.label;
    return typeof label === 'string' && !!label;
  });
  if (options.length) {
    const list = document.createElement('div');
    list.className = 'q-options';
    for (const option of options) {
      const label = typeof option === 'string' ? option : option?.label;
      const row = optionRow(label, typeof option === 'object' ? option.description : null, false, false);
      row.tabIndex = 0;
      const submit = () => window.flavorIsland.answer(pend.key, { answer: label });
      row.onclick = submit;
      row.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); submit(); }
      };
      list.appendChild(row);
    }
    question.appendChild(list);
  } else {
    const input = document.createElement('input');
    input.className = 'q-input';
    input.placeholder = '输入回答';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const submit = document.createElement('button');
    submit.className = 'btn btn-submit';
    submit.textContent = '回答';
    submit.disabled = true;
    input.oninput = () => { submit.disabled = !input.value.trim(); };
    submit.onclick = () => {
      if (input.value.trim()) window.flavorIsland.answer(pend.key, { answer: input.value.trim() });
    };
    input.onkeydown = (event) => {
      if (event.key === 'Enter' && !submit.disabled) submit.click();
    };
    question.appendChild(input);
    actions.appendChild(submit);
    question.appendChild(actions);
  }
  div.appendChild(question);
}

function appendTaskBoard(div, progress) {
  if (!progress) return;
  const board = document.createElement('div');
  board.className = 'task-board';
  const head = document.createElement('div');
  head.className = 'task-board-head';
  head.textContent = progress.summary;
  board.appendChild(head);
  for (const task of progress.tasks) {
    const line = document.createElement('div');
    line.className = `task-line task-${task.status}`;
    const mark = document.createElement('span');
    mark.className = 'task-mark';
    mark.textContent = task.status === 'completed' ? '✓'
      : task.status === 'failed' ? '×'
        : task.status === 'blocked' || task.status === 'cancelled' ? '·'
          : task.status === 'in_progress' || task.status === 'running' ? '›' : '·';
    const label = document.createElement('span');
    label.className = 'task-label';
    label.textContent = (task.status === 'in_progress' || task.status === 'running')
      ? task.activeForm : task.label;
    line.append(mark, label);
    board.appendChild(line);
  }
  div.appendChild(board);
}

function appendLoopOutcome(div, loop) {
  if (!loop) return;
  const passed = loop.outcome === 'succeeded' || loop.verification?.passed === true;
  const card = document.createElement('div');
  card.className = `loop-card ${passed ? 'loop-pass' : 'loop-fail'}`;
  const title = document.createElement('div');
  title.className = 'loop-title';
  title.textContent = `${passed ? '✓' : '×'} Loop ${passed ? 'verified' : loop.outcome}`;
  const reason = document.createElement('div');
  reason.className = 'loop-reason';
  reason.textContent = loop.verification?.summary || loop.reason || 'Loop finished.';
  card.append(title, reason);
  div.appendChild(card);
}

function optionRow(label, description, multi, selected) {
  const row = document.createElement('div');
  row.className = `opt${multi ? ' opt-multi' : ''}${selected ? ' selected' : ''}`;
  row.tabIndex = 0;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(selected));
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
  };
  // The mark is a CSS-drawn radio/checkbox (circle vs rounded square) so it
  // stays crisp regardless of font glyph availability.
  const mark = document.createElement('span');
  mark.className = 'opt-mark';
  const body = document.createElement('div');
  body.className = 'opt-body';
  const lab = document.createElement('span');
  lab.className = 'opt-label';
  lab.textContent = label;
  body.appendChild(lab);
  if (description) {
    const d = document.createElement('span');
    d.className = 'opt-desc';
    d.textContent = description;
    body.appendChild(d);
  }
  row.append(mark, body);
  return row;
}

function setCustomChecked(customEl, checked) {
  const box = customEl.querySelector('.q-custom-check');
  if (box) box.checked = checked;
  // Keep the row's solid "counts as answer" treatment in sync with the box.
  customEl.classList.toggle('checked', !!checked);
}

// Final custom-input item: checkbox on the left, single-line text input on the
// right, on the same horizontal row. The checkbox gates whether the typed text
// counts as the answer (`qd.other`); the input holds the text (`qd.otherText`).
// They are independent: toggling the checkbox never clears typed text, and the
// input accepts single-line text regardless of the checkbox state.
function customRow(q, qd, onChanged) {
  const row = document.createElement('div');
  row.className = `q-custom${qd.other ? ' checked' : ''}`;

  const label = document.createElement('label');
  label.className = 'q-custom-check-label';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'q-custom-check';
  box.checked = qd.other;
  box.title = '使用自定义回答';
  box.setAttribute('aria-label', '使用自定义回答');
  box.onchange = (e) => {
    qd.other = e.target.checked;
    // A checked custom box takes over from the picked option for single-select.
    if (!q.multiSelect && qd.other) qd.value = null;
    row.classList.toggle('checked', qd.other);
    onChanged();
  };
  label.appendChild(box);

  const input = document.createElement('input');
  input.className = 'q-input q-custom-input';
  input.type = 'text';
  input.placeholder = '或输入自定义回答…';
  input.value = qd.otherText;
  input.oninput = (e) => { qd.otherText = e.target.value; onChanged(); };
  // Refresh the Submit enabled state when focus leaves or Enter is pressed —
  // never mid-typing, so the input keeps focus.
  input.onchange = () => onChanged();
  input.onkeydown = (e) => { if (e.key === 'Enter') { qd.otherText = input.value; onChanged(); } };

  row.append(label, input);
  return row;
}

function textInput(qd, onChanged) {
  const input = document.createElement('input');
  input.className = 'q-input';
  input.type = 'text';
  input.placeholder = '输入你的回答…';
  input.value = qd.otherText;
  input.oninput = (e) => { qd.otherText = e.target.value; onChanged(); };
  // Refresh the Submit enabled state when focus leaves or Enter is pressed —
  // never mid-typing, so the input keeps focus.
  input.onchange = () => onChanged();
  input.onkeydown = (e) => { if (e.key === 'Enter') { qd.otherText = input.value; onChanged(); } };
  return input;
}

function showToast(message, failed = false) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.className = failed ? 'toast toast-error' : 'toast';
  toast.textContent = message;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.classList.add('toast-out'); }, 2200);
}

function appendSessionControls(div, row) {
  const capabilities = new Set(row.controls || []);
  if (!capabilities.size) return;
  const card = document.createElement('div');
  card.className = 'control-card';
  const head = document.createElement('div');
  head.className = 'control-head';
  head.innerHTML = '<span>SESSION CONTROL</span><i>LOCAL PIPE</i>';
  const quick = document.createElement('div');
  quick.className = 'control-quick';
  const run = async (command, message, button) => {
    button.disabled = true;
    try {
      await window.flavorIsland.control(row.id, command, message);
      showToast(command === 'abort' ? '已发送停止请求' : command === 'focus' ? '已聚焦桌面任务' : '消息已发送');
    } catch (error) {
      showToast(error.message || '操作失败', true);
    } finally { button.disabled = false; }
  };
  if (capabilities.has('focus')) {
    const focus = document.createElement('button');
    focus.className = 'mini-btn'; focus.type = 'button'; focus.textContent = '聚焦任务';
    focus.onclick = () => run('focus', null, focus);
    quick.appendChild(focus);
  }
  if (capabilities.has('abort') && row.statusKey !== 'idle') {
    const stop = document.createElement('button');
    stop.className = 'mini-btn mini-danger'; stop.type = 'button'; stop.textContent = '停止任务';
    stop.onclick = () => { if (confirm('停止这个 flavor-code 任务？')) run('abort', null, stop); };
    quick.appendChild(stop);
  }
  card.append(head, quick);
  if (capabilities.has('steer') || capabilities.has('follow_up')) {
    const compose = document.createElement('div');
    compose.className = 'control-compose';
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = '追加指令或下一轮消息…'; input.setAttribute('aria-label', '会话消息');
    const send = document.createElement('button');
    send.type = 'button'; send.className = 'mini-btn';
    const preferFollowUp = row.statusKey === 'idle' && capabilities.has('follow_up');
    send.textContent = preferFollowUp ? 'Follow-up' : 'Steer';
    const command = preferFollowUp ? 'follow_up' : 'steer';
    const submit = async () => {
      const message = input.value.trim();
      if (!message) return;
      await run(command, message, send);
      if (!send.disabled) input.value = '';
    };
    send.onclick = submit;
    input.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); }
    };
    input.oninput = () => { send.disabled = !input.value.trim(); };
    send.disabled = true;
    compose.append(input, send);
    card.appendChild(compose);
  }
  div.appendChild(card);
}

function render({ model, pending, sounds, settings = {}, notch: notchInfo = null }) {
  // Keep the latest push so a detail toggle can re-render without a new push.
  lastRenderState = { model, pending, sounds, settings, notch: notchInfo };
  reducedMotion = settings.motion === 'reduced'
    || (settings.motion !== 'full' && SYSTEM_REDUCED_MOTION);
  document.body.classList.toggle('reduce-motion', reducedMotion);
  if (typeof mascot.setReducedMotion === 'function') mascot.setReducedMotion(reducedMotion);
  (sounds || []).forEach(playSound);

  // macOS notch fusion: hand the notch geometry to CSS as custom properties
  // and flip the body into notch mode. Mirrors CodeIsland's ScreenDetector —
  // main already sized the window to sit behind the physical notch; the CSS
  // lays the bar out as left wing / notch gap / right wing.
  if (notchInfo && notchInfo.hasNotch) {
    document.documentElement.style.setProperty('--notch-h', `${notchInfo.notchHeight}px`);
    document.documentElement.style.setProperty('--notch-w', `${notchInfo.notchWidth}px`);
    // Cover mode lifts the window above the screen top to hide macOS's rounded
    // window corners; pad the bar's content down by the same amount so its
    // square top edge still lands flush on y=0.
    document.documentElement.style.setProperty('--notch-overscan', `${notchInfo.overscan || 0}px`);
    document.body.classList.add('notch');
    // 'below' = macOS clamped the window under the notch; the bar hugs the
    // notch's bottom edge at wing height instead of covering the cutout.
    document.body.classList.toggle('notch-below', notchInfo.flush === 'below');
  } else {
    document.body.classList.remove('notch');
    document.body.classList.remove('notch-below');
  }

  // Pill
  const hasPanelContent = model.rows.length > 0;
  if (!hasPanelContent) manualPanelOpen = null;
  const wantsPanel = (model.autoExpand && model.requiresAttention) || (manualPanelOpen === null
    ? (model.autoExpand && !model.collapsed)
    : manualPanelOpen);
  const panelOpen = hasPanelContent && wantsPanel;
  islandEl.classList.toggle('collapsed', !panelOpen);
  pillEl.setAttribute('aria-expanded', String(panelOpen));
  pillEl.setAttribute('aria-disabled', String(!hasPanelContent));
  pillEl.setAttribute('aria-label', hasPanelContent
    ? `Flavor Island，${model.activeCount} 个进行中的会话${model.requiresAttention ? '，需要处理' : ''}，点击展开会话`
    : 'Flavor Island，暂无会话');
  pillEl.title = hasPanelContent
    ? (notchInfo?.hasNotch ? '点击展开会话' : '点击展开会话；拖动可移动窗口')
    : '暂无会话；右键打开菜单';
  const top = model.rows[0];
  pillEl.className = `pill state-${model.mascotState}${top?.tool ? ' has-tool' : ''}`;
  mascot.setState(model.mascotState);
  // CodeIsland's right wing shows the session count. Keep this one strictly
  // active so an idle session cannot look like an extra running process.
  pillCountEl.textContent = model.count > 0 ? String(model.activeCount) : '';
  pillCountEl.title = `${model.activeCount} 个进行中的会话`;
  pillAlertEl.classList.toggle('visible', model.requiresAttention);

  // Main debounces tool chips, but a reveal/swap still changes the pill text
  // and thus its width — tween the width so the pill stretches instead of
  // snapping (a hard jump reads as flicker on the transparent window).
  const pillW0 = pillEl.getBoundingClientRect().width;

  pillStatusEl.className = 'pill-status';
  if (!top) {
    // Brand/idle reading takes the pixel display face (see .pill-status.brand).
    pillStatusEl.classList.add('brand');
    pillStatusEl.textContent = 'Flavor Island';
  } else if (top.tool) {
    // The compact left wing mirrors CodeIsland: mascot plus a short tool name.
    pillStatusEl.classList.add('tool', `tk-${top.toolKey || 'tool'}`);
    pillStatusEl.textContent = top.tool;
  } else if (top.pending) {
    // Needs a human decision: short accent label (matches the bell badge in
    // CodeIsland's right wing) instead of the long "title · Needs approval".
    pillStatusEl.classList.add('pending');
    pillStatusEl.textContent = top.statusKey === 'waitingQuestion' ? 'Question' : 'Approval';
  } else {
    pillStatusEl.textContent = top.statusLabel;
  }

  if (!reducedMotion && !notchInfo?.hasNotch && typeof pillEl.animate === 'function') {
    const pillW1 = pillEl.getBoundingClientRect().width;
    if (Math.abs(pillW1 - pillW0) > 2) {
      pillEl.animate(
        [{ width: `${pillW0}px` }, { width: `${pillW1}px` }],
        { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
      );
    }
  }

  // Panel rows. Rebuilding the DOM replays every row's entry animation, which
  // flashes on the transparent window — suppress it while the row set (ids +
  // statuses) is unchanged, so only genuinely new layouts animate in.
  const panelSig = `${panelOpen ? 'e' : 'c'}|${model.rows.map((r) => `${r.id}:${r.statusKey}`).join(',')}`;
  panelEl.classList.toggle('settled', panelEl.dataset.sig === panelSig);
  panelEl.dataset.sig = panelSig;
  // When the row set changes (session added/removed), a previously opened
  // detail may point at a stale row — close it and re-key the open state.
  const rowSet = model.rows.map((r) => r.id).join('\u0001');
  if (rowSet !== lastRowSet) {
    lastRowSet = rowSet;
    openDetailId = null;
  }
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey || null;
  const selection = active && typeof active.selectionStart === 'number'
    ? { start: active.selectionStart, end: active.selectionEnd } : null;
  panelEl.innerHTML = '';
  // Show both numbers explicitly so saved idle rows are never mistaken for
  // work that is still running.
  if (model.count > 0) {
    const head = document.createElement('div');
    head.className = 'panel-head';
    head.innerHTML = `<span>${model.activeCount} active · ${model.count} session${model.count === 1 ? '' : 's'}</span>`
      + `<span class="head-actions">`
      + `<button class="settings-btn" type="button" aria-label="打开设置" title="设置">⚙</button>`
      // Quit lives in the header because on a notch Mac the tray icon can be
      // squeezed behind the cutout — the island itself must be able to exit.
      + `<button class="settings-btn quit-btn" type="button" aria-label="退出 Flavor Island" title="退出 (⌘Q)">⏻</button>`
      + `</span>`;
    head.querySelector('.settings-btn').onclick = () => window.flavorIsland.openSettings();
    head.querySelector('.quit-btn').onclick = () => window.flavorIsland.quit();
    panelEl.appendChild(head);
  }
  const stagger = !panelEl.classList.contains('settled');
  model.rows.forEach((row, i) => {
    const pend = row.pending ? pendingForSession(pending, row.id) : null;
    const div = document.createElement('div');
    div.className = `row s-${row.statusKey}`;
    // Orchestrated panel entry: fresh layouts cascade in 30ms apart (capped so
    // long lists don't drag); settled re-renders skip animation entirely.
    if (stagger) div.style.animationDelay = `${Math.min(i, 6) * 30}ms`;
    // While a tool runs, the status chip shows the tool in its category color
    // instead of the plain status text.
    const statusText = row.tool || row.taskProgress?.summary || row.statusLabel;
    const statusClass = row.tool ? `row-status tk-${row.toolKey || 'tool'}` : 'row-status';
    // The ask card renders the question text itself — the row description
    // would just duplicate the first question above the card.
    const showDesc = row.toolDescription && !(pend && (pend.kind === 'askUserQuestion' || pend.kind === 'question'));
    const isOpen = row.id === openDetailId;
    div.classList.toggle('open', isOpen);
    div.innerHTML = `
      <div class="row-head" role="button" tabindex="0" aria-expanded="${isOpen}">
        <img class="row-icon" src="../assets/flavor.png" alt="" />
        <span class="row-title" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</span>
        <span class="${statusClass}">${escapeHtml(statusText)}</span>
        <span class="detail-chevron">▸</span>
      </div>
      ${showDesc ? `<div class="row-desc">${escapeHtml(row.toolDescription)}</div>` : ''}
      ${isOpen ? `<div class="row-detail">${buildRowDetail(row)}</div>` : ''}
    `;
    // Clicking the head toggles the detail block. The permission buttons and
    // ask-card inputs live outside .row-head (in .actions / ask cards), so
    // their clicks never reach this handler. Opening one row closes any other
    // open detail.
    const rowHead = div.querySelector('.row-head');
    rowHead.addEventListener('click', () => {
      openDetailId = openDetailId === row.id ? null : row.id;
      rerender();
    });
    rowHead.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); rowHead.click(); }
    });
    if (isOpen && row.startTime) ensureDurationTimer();
    appendTaskBoard(div, row.taskProgress);
    appendLoopOutcome(div, row.loopOutcome);
    if (isOpen) appendSessionControls(div, row);
    if (pend && pend.kind === 'permission') {
      if (pend.reason || pend.toolCategory) {
        const context = document.createElement('div');
        context.className = 'approval-context';
        if (pend.toolCategory) {
          const category = document.createElement('span');
          category.className = `approval-category tk-${pend.toolCategory}`;
          category.textContent = pend.toolCategory;
          context.appendChild(category);
        }
        if (pend.reason) {
          const reason = document.createElement('span');
          reason.className = 'approval-reason';
          reason.textContent = pend.reason;
          context.appendChild(reason);
        }
        div.appendChild(context);
      }
      const actions = document.createElement('div');
      actions.className = 'actions';
      const allow = document.createElement('button');
      allow.className = 'btn btn-allow';
      allow.textContent = 'Allow once';
      allow.onclick = () => window.flavorIsland.decide(pend.key, 'allow');
      // The host may additionally offer a category-scoped session grant.
      const deny = document.createElement('button');
      deny.className = 'btn btn-deny';
      deny.textContent = 'Deny';
      deny.onclick = () => window.flavorIsland.decide(pend.key, 'deny');
      actions.append(allow, deny);
      // Only flavor-code may declare a request cacheable. Destructive and
      // collaboration-sharing approvals never expose this broader action.
      if (pend.allowAlways) {
        const allowAll = document.createElement('button');
        allowAll.className = 'btn btn-allow-all';
        allowAll.textContent = 'Allow for session';
        allowAll.title = pend.toolCategory
          ? `Allow the ${pend.toolCategory} category for this flavor-code session`
          : 'Allow this category for the current flavor-code session';
        allowAll.onclick = () => window.flavorIsland.decide(pend.key, 'allowAll');
        actions.appendChild(allowAll);
      }
      div.appendChild(actions);
    } else if (pend && pend.kind === 'askUserQuestion' && pend.questions) {
      // Selection changes patch the card in place (see buildAskCard) instead of
      // re-rendering, so clicking options doesn't flash the panel.
      buildAskCard(div, pend);
    } else if (pend && pend.kind === 'question') {
      buildPlainQuestionCard(div, pend);
    }
    div.querySelectorAll('button,input,.opt,.row-head').forEach((element, index) => {
      element.dataset.focusKey = `${row.id}:${index}`;
    });
    panelEl.appendChild(div);
  });

  if (focusKey) {
    const next = [...panelEl.querySelectorAll('[data-focus-key]')].find((element) => element.dataset.focusKey === focusKey);
    if (next) {
      next.focus({ preventScroll: true });
      if (selection && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(selection.start, selection.end); } catch { /* input type may not support selection */ }
      }
    }
  }

  // Ask main to fit the window to content. The island now fills the window
  // (height:100%) so its layout box equals the current window height, not the
  // natural content height — measure the pieces directly instead. The panel's
  // scrollHeight is the full, uncapped content height regardless of how tall the
  // panel's own (flex/clamped) box is, so this can't feed back on the window size.
  requestAnimationFrame(() => {
    const pillRect = pillEl.getBoundingClientRect();
    const notchMode = document.body.classList.contains('notch');
    const expanded = !islandEl.classList.contains('collapsed');
    let h;
    let w = null;
    if (notchMode) {
      // CodeIsland uses a narrow compact bar and a wider panel only when there
      // is content to show. Widths remain symmetric around the physical notch.
      h = Math.ceil(pillRect.height) + 4 /* buffer */;
      if (expanded) h += panelEl.scrollHeight;
      const compactWidth = Math.ceil(pillRect.width) + 8 /* shoulder tabs */;
      w = expanded
        ? Math.max(compactWidth, Math.min(620, Math.max(580, (notchInfo?.notchWidth || 200) + 200)))
        : compactWidth;
    } else {
      h = Math.ceil(pillRect.height) + 8 /* island top+bottom padding */ + 4 /* buffer */;
      if (expanded) h += 6 /* gap above panel */ + panelEl.scrollHeight;
      // body{overflow:hidden} clips any drop shadow reaching past the window
      // edge — that hard line is the "weird" bottom shadow. Reserve room for it.
      // The pad is transparent and click-through, so it costs nothing.
      h += SHADOW_PAD;
    }
    // Skip no-op resizes: re-applying identical bounds still forces a window
    // redraw, which shows up as a flicker on the transparent window.
    if (h === lastResizeH && w === lastResizeW) return;
    lastResizeH = h;
    lastResizeW = w;
    window.flavorIsland.resize(h, w);
  });
}

// Re-render with the last state push after a detail toggle. Sounds are dropped
// so a local click never replays a state-change sound.
function rerender() {
  if (!lastRenderState) return;
  render({ ...lastRenderState, sounds: [] });
}

// Manual drag by the pill. A CSS -webkit-app-region:drag region would move the
// window natively but swallows mouse events at the OS level, so the recenter
// dblclick below would never fire. Instead we track the cursor ourselves:
// window.screenX/Y is the window's current top-left in screen coordinates, and
// the cursor's screenX/Y delta from mousedown tells us how far to move it.
let dragStart = null; // { mouseX, mouseY, winX, winY }
let suppressPillClick = false;

function togglePanel() {
  if (!lastRenderState?.model?.rows?.length) return;
  const currentlyOpen = !islandEl.classList.contains('collapsed');
  manualPanelOpen = !currentlyOpen;
  rerender();
}

pillEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left button only
  // A notch-fused bar is pinned to the physical notch — dragging it off makes
  // no sense (and on macOS the fused window shouldn't leave the screen top),
  // so drag is disabled entirely while fused. A click still expands the panel.
  if (document.body.classList.contains('notch')) return;
  dragStart = { mouseX: e.screenX, mouseY: e.screenY, winX: window.screenX, winY: window.screenY, moved: false };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  // If the button was released off-window (a fast drag can outrun the window and
  // miss the mouseup), stop dragging instead of sticking to the cursor.
  if ((e.buttons & 1) === 0) { dragStart = null; return; }
  if (Math.abs(e.screenX - dragStart.mouseX) + Math.abs(e.screenY - dragStart.mouseY) > 4) {
    dragStart.moved = true;
  }
  const x = dragStart.winX + (e.screenX - dragStart.mouseX);
  const y = dragStart.winY + (e.screenY - dragStart.mouseY);
  window.flavorIsland.moveWindow(x, y);
});

window.addEventListener('mouseup', () => {
  suppressPillClick = !!dragStart?.moved;
  dragStart = null;
});

pillEl.addEventListener('click', () => {
  if (suppressPillClick) { suppressPillClick = false; return; }
  togglePanel();
});
pillEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  togglePanel();
});

// Click-through: the transparent window swallows clicks on every pixel, so the
// area around the visible pill/panel would block whatever is underneath. Hit-test
// the cursor and tell main to ignore mouse events everywhere except over content.
// Because main forwards moves while ignoring, this handler keeps firing so we can
// re-arm the window the moment the cursor returns to the pill/panel.
let ignoringMouse = null;
function updateMousePassthrough(x, y) {
  // Stay interactive throughout a drag so a fast drag isn't dropped mid-move.
  let overContent = !!dragStart;
  if (!overContent) {
    const el = document.elementFromPoint(x, y);
    overContent = !!el && (pillEl.contains(el) || panelEl.contains(el));
  }
  const ignore = !overContent;
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  window.flavorIsland.setIgnoreMouse(ignore);
}
window.addEventListener('mousemove', (e) => updateMousePassthrough(e.clientX, e.clientY));

// Double-click the pill to bring a dragged island back to its top-center home.
pillEl.addEventListener('dblclick', () => window.flavorIsland.resetPosition());

// Right-click anywhere on the island pops the native menu (settings / reset /
// quit). On a notch Mac the tray icon can hide behind the cutout, so the bar
// and panel must carry their own exit affordance in every state.
for (const el of [pillEl, panelEl]) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.flavorIsland.showContextMenu();
  });
}

// ⌘Q (Ctrl+Q off macOS) quits while the island window holds focus — the only
// keyboard path, since a screen-saver-level overlay never installs a global
// hotkey (that would hijack ⌘Q from every other app).
window.addEventListener('keydown', (e) => {
  const mod = window.flavorIsland.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'q') {
    e.preventDefault();
    window.flavorIsland.quit();
  }
});

window.flavorIsland.onState(render);
