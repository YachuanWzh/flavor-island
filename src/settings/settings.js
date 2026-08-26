'use strict';

const ids = {
  sounds: 'sounds', autoExpand: 'auto-expand', launchAtLogin: 'launch-at-login',
  motion: 'motion', privacyMode: 'privacy-mode',
};
const priceIds = {
  inputPerMillion: 'price-input', outputPerMillion: 'price-output',
  cacheReadPerMillion: 'price-cache-read', cacheCreationPerMillion: 'price-cache-create',
};
let applying = false;
let saveTimer = null;

function apply({ settings, status }) {
  applying = true;
  for (const [key, id] of Object.entries(ids)) {
    const input = document.getElementById(id);
    if (input.type === 'checkbox') input.checked = !!settings[key]; else input.value = settings[key];
  }
  for (const [key, id] of Object.entries(priceIds)) document.getElementById(id).value = settings.pricing[key] || '';
  const serverLabels = { connected: '已连接', retrying: '重试中', starting: '启动中' };
  const pluginLabels = { installed: '已安装', installing: '安装中' };
  document.getElementById('server-status').textContent = serverLabels[status.server] || status.server;
  document.getElementById('plugin-status').textContent = pluginLabels[status.plugin] || status.plugin;
  document.getElementById('session-count').textContent = String(status.sessions);
  const connection = document.querySelector('.connection-card');
  connection.classList.toggle('connected', status.server === 'connected');
  document.getElementById('live-label').textContent = status.server === 'connected' ? '运行正常' : '正在连接';
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

window.flavorSettings.onState(apply);
window.flavorSettings.get().then(apply);
