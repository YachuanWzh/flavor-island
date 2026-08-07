'use strict';

// Renderer: receives state pushes from main, renders the island, plays sounds,
// and sends permission decisions back. renderModel already did the heavy lifting
// in the main process, so this stays a thin DOM layer.

const islandEl = document.getElementById('island');
const pillEl = document.getElementById('pill');
const pillStatusEl = document.getElementById('pill-status');
const pillCountEl = document.getElementById('pill-count');
const panelEl = document.getElementById('panel');

// Canvas pixel mascot (sleep / typing / startled scenes, see mascot.js).
const mascot = createMascot(document.getElementById('mascot'));
mascot.start();

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

// Draft answers for in-flight AskUserQuestion cards, keyed by pending key, so the
// user's selections survive the periodic state re-renders. Each draft is an array
// (one entry per question): { value, set: string[], other, otherText }.
const askDrafts = new Map();

// Last height sent to main for a window resize — guards against no-op resizes.
let lastResizeH = 0;

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
      const refreshRows = () => rows.forEach(({ row, isSelected }) => row.classList.toggle('selected', isSelected()));
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
  refreshSubmit();
  actions.append(skip, submitBtn);
  div.appendChild(actions);
}

function optionRow(label, description, multi, selected) {
  const row = document.createElement('div');
  row.className = `opt${multi ? ' opt-multi' : ''}${selected ? ' selected' : ''}`;
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
}

// Final custom-input item: checkbox on the left, single-line text input on the
// right, on the same horizontal row. The checkbox gates whether the typed text
// counts as the answer (`qd.other`); the input holds the text (`qd.otherText`).
// They are independent: toggling the checkbox never clears typed text, and the
// input accepts single-line text regardless of the checkbox state.
function customRow(q, qd, onChanged) {
  const row = document.createElement('div');
  row.className = 'q-custom';

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
    onChanged();
  };
  label.appendChild(box);

  const input = document.createElement('input');
  input.className = 'q-input q-custom-input';
  input.type = 'text';
  input.placeholder = '或输入自定义回答…';
  input.value = qd.otherText;
  input.oninput = (e) => { qd.otherText = e.target.value; };
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
  input.oninput = (e) => { qd.otherText = e.target.value; };
  // Refresh the Submit enabled state when focus leaves or Enter is pressed —
  // never mid-typing, so the input keeps focus.
  input.onchange = () => onChanged();
  input.onkeydown = (e) => { if (e.key === 'Enter') { qd.otherText = input.value; onChanged(); } };
  return input;
}

function render({ model, pending, sounds }) {
  (sounds || []).forEach(playSound);

  // Pill
  islandEl.classList.toggle('collapsed', model.collapsed);
  pillEl.className = `pill state-${model.mascotState}`;
  mascot.setState(model.mascotState);
  // Quiet mode: only surface the session count while the island is expanded for a
  // pending decision — no badge churn during background activity.
  pillCountEl.textContent = !model.collapsed && model.count > 0 ? String(model.count) : '';

  const top = model.rows[0];
  pillStatusEl.className = 'pill-status';
  if (!top) {
    pillStatusEl.textContent = 'Flavor Island';
  } else if (top.tool) {
    // Active tool reads like CodeIsland's compact wing: colored tool name plus
    // the first line of its description ("Bash · npm test").
    pillStatusEl.classList.add(`tk-${top.toolKey || 'tool'}`);
    const desc = top.toolDescription ? ` · ${String(top.toolDescription).split('\n')[0].slice(0, 60)}` : '';
    pillStatusEl.textContent = `${top.title} · ${top.tool}${desc}`;
  } else if (top.pending) {
    pillStatusEl.textContent = `${top.title} · ${top.statusLabel}`;
  } else {
    pillStatusEl.textContent = top.statusLabel;
  }

  // Panel rows. Rebuilding the DOM replays every row's entry animation, which
  // flashes on the transparent window — suppress it while the row set (ids +
  // statuses) is unchanged, so only genuinely new layouts animate in.
  const panelSig = `${model.collapsed ? 'c' : 'e'}|${model.rows.map((r) => `${r.id}:${r.statusKey}`).join(',')}`;
  panelEl.classList.toggle('settled', panelEl.dataset.sig === panelSig);
  panelEl.dataset.sig = panelSig;
  panelEl.innerHTML = '';
  for (const row of model.rows) {
    const pend = row.pending ? pendingForSession(pending, row.id) : null;
    const div = document.createElement('div');
    div.className = `row s-${row.statusKey}`;
    // While a tool runs, the status chip shows the tool in its category color
    // instead of the plain status text.
    const statusText = row.tool || row.statusLabel;
    const statusClass = row.tool ? `row-status tk-${row.toolKey || 'tool'}` : 'row-status';
    // The ask card renders the question text itself — the row description
    // would just duplicate the first question above the card.
    const showDesc = row.toolDescription && !(pend && pend.kind === 'askUserQuestion');
    div.innerHTML = `
      <div class="row-head">
        <img class="row-icon" src="../assets/flavor.png" alt="" />
        <span class="row-title">${escapeHtml(row.title)}</span>
        <span class="${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      ${showDesc ? `<div class="row-desc">${escapeHtml(row.toolDescription)}</div>` : ''}
    `;
    if (pend && pend.kind === 'permission') {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const allow = document.createElement('button');
      allow.className = 'btn btn-allow';
      allow.textContent = 'Allow';
      allow.onclick = () => window.flavorIsland.decide(pend.key, 'allow');
      // "Allow all" approves this call and persists a session rule so every later
      // call to the same tool is auto-approved without re-prompting.
      const allowAll = document.createElement('button');
      allowAll.className = 'btn btn-allow-all';
      allowAll.textContent = 'Allow all';
      allowAll.title = pend.toolName
        ? `Always allow ${pend.toolName} for this session`
        : 'Always allow this tool for this session';
      allowAll.onclick = () => window.flavorIsland.decide(pend.key, 'allowAll');
      const deny = document.createElement('button');
      deny.className = 'btn btn-deny';
      deny.textContent = 'Deny';
      deny.onclick = () => window.flavorIsland.decide(pend.key, 'deny');
      actions.append(allow, allowAll, deny);
      div.appendChild(actions);
    } else if (pend && pend.kind === 'askUserQuestion' && pend.questions) {
      // Selection changes patch the card in place (see buildAskCard) instead of
      // re-rendering, so clicking options doesn't flash the panel.
      buildAskCard(div, pend);
    }
    panelEl.appendChild(div);
  }

  // Ask main to fit the window to content. The island now fills the window
  // (height:100%) so its layout box equals the current window height, not the
  // natural content height — measure the pieces directly instead. The panel's
  // scrollHeight is the full, uncapped content height regardless of how tall the
  // panel's own (flex/clamped) box is, so this can't feed back on the window size.
  requestAnimationFrame(() => {
    const pillH = Math.ceil(pillEl.getBoundingClientRect().height);
    let h = pillH + 8 /* island top+bottom padding */ + 4 /* buffer */;
    if (!islandEl.classList.contains('collapsed')) {
      h += 6 /* gap above panel */ + panelEl.scrollHeight;
    }
    // body{overflow:hidden} clips any drop shadow reaching past the window edge —
    // that hard line is the "weird" bottom shadow. Reserve room for it. The pad is
    // transparent and click-through, so it costs nothing in occlusion.
    h += SHADOW_PAD;
    // Skip no-op resizes: re-applying identical bounds still forces a window
    // redraw, which shows up as a flicker on the transparent window.
    if (h === lastResizeH) return;
    lastResizeH = h;
    window.flavorIsland.resize(h);
  });
}

// Manual drag by the pill. A CSS -webkit-app-region:drag region would move the
// window natively but swallows mouse events at the OS level, so the recenter
// dblclick below would never fire. Instead we track the cursor ourselves:
// window.screenX/Y is the window's current top-left in screen coordinates, and
// the cursor's screenX/Y delta from mousedown tells us how far to move it.
let dragStart = null; // { mouseX, mouseY, winX, winY }

pillEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left button only
  dragStart = { mouseX: e.screenX, mouseY: e.screenY, winX: window.screenX, winY: window.screenY };
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  // If the button was released off-window (a fast drag can outrun the window and
  // miss the mouseup), stop dragging instead of sticking to the cursor.
  if ((e.buttons & 1) === 0) { dragStart = null; return; }
  const x = dragStart.winX + (e.screenX - dragStart.mouseX);
  const y = dragStart.winY + (e.screenY - dragStart.mouseY);
  window.flavorIsland.moveWindow(x, y);
});

window.addEventListener('mouseup', () => { dragStart = null; });

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

window.flavorIsland.onState(render);
