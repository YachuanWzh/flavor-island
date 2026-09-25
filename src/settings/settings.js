'use strict';

const ids = {
  sounds: 'sounds', autoExpand: 'auto-expand', launchAtLogin: 'launch-at-login',
  motion: 'motion', privacyMode: 'privacy-mode',
  notchMode: 'notch-mode', notchWidth: 'notch-width', notchHeight: 'notch-height',
};
const priceIds = {
  inputPerMillion: 'price-input', outputPerMillion: 'price-output',
  cacheReadPerMillion: 'price-cache-read', cacheCreationPerMillion: 'price-cache-create',
};
let applying = false;
let saveTimer = null;
let latestStatus = null;

function refreshConnection() {
  const status = latestStatus;
  if (!status) return;
  const listening = status.server === 'connected';
  const received = Number.isFinite(status.lastHookAt);
  const age = received ? Math.max(0, Date.now() - status.lastHookAt) : null;
  const recent = received && age < 5 * 60 * 1000;
  const pluginOnline = Number.isFinite(status.pluginSeenAt) && Date.now() - status.pluginSeenAt < 90_000;
  document.querySelector('.connection-card').classList.toggle('connected', (pluginOnline || recent) && listening);
  document.getElementById('live-label').textContent = !listening ? '服务未就绪'
    : recent ? '正在接收 Flavor Code 事件' : pluginOnline ? '插件已接入，等待事件' : '等待 Flavor Code 插件';
  document.getElementById('last-hook-status').textContent = !received ? '尚未收到'
    : age < 60_000 ? '刚刚' : `${Math.floor(age / 60_000)} 分钟前`;
  document.getElementById('connection-hint').textContent = listening && !pluginOnline && !received
    ? '如果 Flavor Code 在插件安装或升级前已经启动，请重启该会话。'
    : listening && !recent ? '暂时没有新事件；运行任务后此处会更新。' : '';
}

function apply({ settings, status }) {
  applying = true;
  latestStatus = status;
  for (const [key, id] of Object.entries(ids)) {
    const input = document.getElementById(id);
    if (input.type === 'checkbox') input.checked = !!settings[key]; else input.value = settings[key];
  }
  for (const [key, id] of Object.entries(priceIds)) document.getElementById(id).value = settings.pricing[key] || '';
  const serverLabels = { connected: '监听中', retrying: '重试中', starting: '启动中' };
  const pluginLabels = { installed: '已安装', installing: '安装中' };
  document.getElementById('server-status').textContent = serverLabels[status.server] || status.server;
  document.getElementById('plugin-status').textContent = pluginLabels[status.plugin] || status.plugin;
  document.getElementById('session-count').textContent = String(status.sessions);
  document.getElementById('active-session-count').textContent = String(status.activeSessions || 0);
  refreshConnection();
  applying = false;
}

function setSaveState(text, state = 'idle') {
  document.getElementById('save-state').textContent = text;
  document.querySelector('.save-pill').dataset.state = state;
}

function collect() {
  const value = {};
  for (const [key, id] of Object.entries(ids)) {
    const input = document.getElementById(id);
    value[key] = input.type === 'checkbox' ? input.checked : input.value;
  }
  value.pricing = {};
  for (const [key, id] of Object.entries(priceIds)) value.pricing[key] = Number(document.getElementById(id).value) || 0;
  return value;
}

function queueSave() {
  if (applying) return;
  clearTimeout(saveTimer);
  setSaveState('正在保存…', 'saving');
  saveTimer = setTimeout(async () => {
    try {
      await window.flavorSettings.save(collect());
      setSaveState('已保存', 'saved');
    } catch (error) {
      setSaveState(`保存失败：${error.message}`, 'error');
    }
  }, 180);
}

for (const id of [...Object.values(ids), ...Object.values(priceIds)]) {
  document.getElementById(id).addEventListener('input', queueSave);
  document.getElementById(id).addEventListener('change', queueSave);
}
document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('恢复所有默认设置？价格参数也会清空。')) return;
  const settings = await window.flavorSettings.reset();
  const current = await window.flavorSettings.get();
  apply({ ...current, settings });
  setSaveState('已恢复默认设置', 'saved');
});

const sidebar = document.querySelector('.sidebar');
const scrollArea = document.getElementById('settings-scroll');
const navItems = [...document.querySelectorAll('.nav-item')];
const sections = navItems.map((item) => document.getElementById(item.dataset.target));

function setActiveSection(id) {
  sidebar.dataset.active = id;
  for (const item of navItems) item.classList.toggle('active', item.dataset.target === id);
}

for (const item of navItems) {
  item.addEventListener('click', () => {
    document.getElementById(item.dataset.target).scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSection(item.dataset.target);
  });
}

let scrollFrame = 0;
scrollArea.addEventListener('scroll', () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    let active = sections[0].id;
    for (const section of sections) {
      if (section.offsetTop - scrollArea.scrollTop <= 55) active = section.id;
    }
    setActiveSection(active);
  });
});

// ---- Global rules manager: ~/.flavor-code/GLOBAL.md ---------------------
// flavor-code injects that file verbatim into every session's prompt; rules
// are single-line bullets. A disabled rule must live OUTSIDE the document
// (main keeps them in GLOBAL.disabled.json), hence the sidecar-backed IPC.
const globalRuleListEl = document.getElementById('global-rule-list');
const globalAddInputEl = document.getElementById('global-add-input');
const globalAddBtnEl = document.getElementById('global-add-btn');
const globalStatusEl = document.getElementById('global-status');
const globalPathEl = document.getElementById('global-path');
let globalRules = [];
let globalEditing = null; // original text of the row currently in edit mode

function setGlobalStatus(text, ok = true) {
  globalStatusEl.textContent = text;
  globalStatusEl.classList.toggle('error', !ok);
}

async function refreshGlobal() {
  const { rules, path } = await window.flavorSettings.global.list();
  globalRules = rules;
  globalPathEl.textContent = path;
  renderGlobalRules();
}

async function globalOp(run, okText) {
  try {
    await run();
    globalEditing = null;
    await refreshGlobal();
    setGlobalStatus(okText, true);
  } catch (error) {
    globalEditing = null;
    setGlobalStatus(`操作失败：${error.message}`, false);
    try { await refreshGlobal(); } catch { /* file unreadable; status says so */ }
  }
}

function ruleButton(label, onClick, danger = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rule-btn' + (danger ? ' danger' : '');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function buildRuleRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule-row' + (rule.enabled ? '' : ' off');

  const sw = document.createElement('label');
  sw.className = 'switch';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = rule.enabled;
  toggle.setAttribute('aria-label', rule.enabled ? '关闭该规则' : '开启该规则');
  toggle.addEventListener('change', () =>
    globalOp(() => window.flavorSettings.global.toggle(rule.text, toggle.checked),
      toggle.checked ? '已开启' : '已关闭'));
  sw.append(toggle, document.createElement('i'));
  row.appendChild(sw);

  if (globalEditing === rule.text) {
    const edit = document.createElement('input');
    edit.className = 'rule-edit';
    edit.value = rule.text;
    const save = () => globalOp(() => window.flavorSettings.global.update(rule.text, edit.value), '已更新');
    edit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') { globalEditing = null; renderGlobalRules(); }
    });
    row.appendChild(edit);
    row.appendChild(ruleButton('保存', save));
    row.appendChild(ruleButton('取消', () => { globalEditing = null; renderGlobalRules(); }));
  } else {
    const text = document.createElement('span');
    text.className = 'rule-text';
    text.textContent = rule.text;
    row.appendChild(text);
    row.appendChild(ruleButton('编辑', () => { globalEditing = rule.text; renderGlobalRules(); }));
    row.appendChild(ruleButton('删除', () =>
      globalOp(() => window.flavorSettings.global.remove(rule.text), '已删除'), true));
  }
  return row;
}

function renderGlobalRules() {
  globalRuleListEl.textContent = '';
  if (globalRules.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'global-empty';
    empty.textContent = '暂无全局规则。添加一条后，flavor-code 的所有新会话都会带上它。';
    globalRuleListEl.appendChild(empty);
    return;
  }
  for (const rule of globalRules) globalRuleListEl.appendChild(buildRuleRow(rule));
}

function addGlobalRule() {
  const text = globalAddInputEl.value.trim();
  if (!text) return;
  globalOp(async () => {
    await window.flavorSettings.global.add(text);
    globalAddInputEl.value = '';
  }, '已添加');
}

globalAddBtnEl.addEventListener('click', addGlobalRule);
globalAddInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') addGlobalRule(); });

window.flavorSettings.onState(apply);
setInterval(refreshConnection, 30_000);

refreshGlobal().catch((error) => {
  globalRuleListEl.textContent = '';
  const empty = document.createElement('p');
  empty.className = 'global-empty';
  empty.textContent = `读取 GLOBAL.md 失败：${error.message}`;
  globalRuleListEl.appendChild(empty);
});
window.flavorSettings.get().then(apply);
