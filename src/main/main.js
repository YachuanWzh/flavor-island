'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createAppState } = require('./appState');
const { createHookServer } = require('../server/hookServer');
const { renderModel } = require('../core/renderModel');
const { computeWindowBounds, computeNotchMetrics, computeNotchWindowBounds } = require('../core/windowLayout');
const { pipePath } = require('../core/pipePath');
const { installPlugin } = require('./pluginInstaller');
const { normalizeSettings, DEFAULT_SETTINGS } = require('../core/settings');
const { sendControlCommand } = require('./controlClient');
const os = require('node:os');
const { parseRuleLines, validateRule, addRule, removeRule, updateRule } = require('../core/globalRules');

const IS_WIN = process.platform === 'win32';

if (IS_WIN) {
  // The island is a pure DOM overlay — no GPU work at all. On machines without a
  // usable GPU (VMs, RDP sessions, broken/older drivers) Chromium's GPU process
  // crash-loops and eventually dies FATAL ("GPU process isn't usable. Goodbye.").
  // Force software rendering end to end. Must run before app is ready; the
  // transparent always-on-top window stays fully functional under software
  // compositing.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  // The GPU process crash code here is 0xC0000409 (fail-fast) from inside the
  // GPU sandbox; disabling just the GPU sandbox lets the software path survive
  // without disabling the renderer/utility sandboxes.
  app.commandLine.appendSwitch('disable-gpu-sandbox');

  // Renderer startup workaround: on some Windows machines (AV software, hardened
  // policies, older CPUs) Chromium's sandbox breaks the renderer process — it
  // crashes at launch with 0x80000003 and every page fails with ERR_FAILED.
  // `--no-sandbox` fixes it. Safe here: the island loads only local trusted
  // content with contextIsolation on and nodeIntegration off, and this app never
  // opens remote pages.
  app.commandLine.appendSwitch('no-sandbox');
}

// Single-instance lock: the app owns one named pipe, so a second instance must
// not try to bind it (EADDRINUSE) — it quits immediately instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });
}

const WIN_WIDTH = 420;
const TOP_MARGIN = 6;

let win = null;
let tray = null;
let settingsWin = null;
let server = null;
let settings = normalizeSettings(DEFAULT_SETTINGS);
let serverStatus = 'starting';
let quitting = false;
// Renderer is not ready to receive state until its page finishes loading.
// Pushing earlier races the load and Electron logs "Render frame was disposed".
let rendererReady = false;
const appState = createAppState();

// Where the user last dragged the island to. `null` means "use the default
// top-center spot". Once set, positionWindow keeps these coordinates so the
// content-driven resizes stop snapping the island back to center.
let userPosition = null;
// The bounds we last applied programmatically, so the `moved` handler can tell
// our own setBounds apart from a real user drag (timing-independent).
let lastSetBounds = null;
// macOS notch geometry for the display the island sits on. { hasNotch:false }
// on Windows or non-notch screens, where the plain top-center pill layout is
// used. Refreshed whenever the display metrics change.
let notch = { hasNotch: false, notchHeight: 0, notchWidth: 0 };
// 'cover': the window sits on the physical screen top and its black bar
// includes the notch area. 'below': macOS refused to lift the window over the
// notch (it clamped the frameless window below the menu bar) — then we hug the
// notch's bottom edge instead and the renderer shrinks the bar to wing height.
let notchFlush = 'cover';
// CodeIsland sizing rules: collapsed bar = notch + two content wings; the
// expanded panel widens toward ~580 logical px, capped by the screen width.
const NOTCH_MIN_WING = 60;

function positionWindow(height, contentWidth = null) {
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds();
  const point = userPosition || { x: current.x + Math.round(current.width / 2), y: current.y + Math.round(current.height / 2) };
  const display = screen.getDisplayNearestPoint(point);
  notch = computeNotchMetrics({
    isMac: process.platform === 'darwin',
    bounds: display.bounds,
    workArea: display.workArea,
    // Windows can't report the cutout, so honor the user's manual notch config.
    // 'auto' = mac-only detection; 'on' forces fusion; 'off' disables it.
    manual: {
      mode: settings.notchMode,
      notchWidth: settings.notchWidth,
      notchHeight: settings.notchHeight,
    },
  });
  // Never let the island grow past the bottom of the screen — clamp to the work
  // area and let the panel scroll internally for content that doesn't fit.
  let bounds;
  if (notch.hasNotch) {
    // Notch mode: pin the window to the very top of the *physical* display so
    // the black bar covers the notch itself (mirrors CodeIsland's panel frame
    // at screen.frame.maxY - height). The user's drag only shifts X — Y stays
    // fused with the notch. Width is content-driven (the renderer measures the
    // bar when collapsed and the panel when expanded), floored at notch + wings.
    // CodeIsland expanded panel: max(nw + 200, 580), capped by the screen.
    // A wider content width from the renderer means the panel is expanded.
    let width = notch.notchWidth + NOTCH_MIN_WING * 2;
    if (contentWidth && contentWidth > width) {
      width = Math.max(width, Math.min(Math.max(notch.notchWidth + 200, 580), contentWidth));
    }
    bounds = computeNotchWindowBounds(height, { bounds: display.bounds, width });
    if (notchFlush === 'below') bounds.y = display.workArea.y;
    if (userPosition) {
      bounds.x = Math.round(Math.min(Math.max(userPosition.x, display.bounds.x),
        display.bounds.x + display.bounds.width - bounds.width));
    }
  } else {
    bounds = computeWindowBounds(height, {
      workArea: display.workArea,
      width: WIN_WIDTH,
      topMargin: TOP_MARGIN,
      min: 1,
      userPosition,
    });
  }
  // Skip no-op resizes: re-applying identical bounds forces a window redraw,
  // which shows up as a flicker on the transparent always-on-top window.
  const cur = win.getBounds();
  if (cur.x === bounds.x && cur.y === bounds.y && cur.width === bounds.width && cur.height === bounds.height) return;
  lastSetBounds = bounds;
  win.setBounds(bounds);
  // Diagnostic: log the raw display geometry + what the notch detector made of
  // it, so a notch-fusion issue can be diagnosed from the terminal alone
  // (topInset is the number that decides hasNotch on macOS; appliedY tells us
  // whether the OS actually let the window sit at the physical screen top or
  // clamped it back down, which is what triggers the 'below' fallback).
  console.log('[notch]', JSON.stringify({
    topInset: display.workArea.y - display.bounds.y,
    bounds: display.bounds,
    workArea: display.workArea,
    notch,
    notchFlush,
    requestedY: bounds.y,
    appliedY: win.getBounds().y,
  }));
  // Clamp probe: we asked for the physical screen top but the window came back
  // lower — this macOS/Electron combo refuses to park a borderless window over
  // the notch. Fall back to hugging the notch's bottom edge and re-place once.
  if (notch.hasNotch && notchFlush === 'cover' && bounds.y === display.bounds.y) {
    const applied = win.getBounds();
    if (applied.y !== display.bounds.y) {
      notchFlush = 'below';
      positionWindow(height, contentWidth);
      return;
    }
  }
  // Notch geometry rides on the state push so the renderer can size the black
  // bar behind the physical notch (CSS custom properties).
  pushState();
}

function createWindow() {
  const islandWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: 56,
    frame: false,
    transparent: true,
    resizable: false,
    // Movable so the OS honors the pill's -webkit-app-region: drag region —
    // without this the drag region is inert and the island can't be moved.
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    // macOS: two things are needed before the window can actually sit on the
    // physical top of the display (over the menu bar / notch):
    //  1. `type: 'panel'` lifts it into the panel layer (above the menu bar's
    //     own window level) — without this, even `alwaysOnTop: 'screen-saver'`
    //     still leaves the window below the menu bar in z-order.
    //  2. `enableLargerThanScreen: true` is what actually disables AppKit's
    //     `constrainFrameRect:toScreen:` clamp. Without it, macOS silently
    //     pushes any `setBounds({ y: 0 })` back down to `visibleFrame`'s top
    //     (the menu bar's bottom edge) — confirmed on a real 14" MBP: the
    //     probe logged `requestedY: 0, appliedY: 33` even with `type: 'panel'`
    //     alone, which kept tripping the `notchFlush: 'below'` fallback.
    // Together these let the black bar cover the notch instead of hugging its
    // bottom edge, mirroring CodeIsland's NSPanel + full-screen-frame usage.
    ...(process.platform === 'darwin' ? { type: 'panel', enableLargerThanScreen: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win = islandWindow;
  islandWindow.setAlwaysOnTop(true, 'screen-saver');
  islandWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // A transparent window still swallows clicks on every pixel, so the fixed-width
  // island would block the mostly-empty area around the pill. Start fully
  // click-through; the renderer re-arms us (set-ignore-mouse) only while the
  // cursor is over visible content. forward:true keeps move events flowing so the
  // renderer can detect re-entry.
  islandWindow.setIgnoreMouseEvents(true, { forward: true });
  islandWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  islandWindow.webContents.on('did-finish-load', () => {
    if (win !== islandWindow) return;
    rendererReady = true;
    // Render whatever state accumulated while the page was loading.
    pushState();
  });
  islandWindow.webContents.on('render-process-gone', () => {
    if (win !== islandWindow) return;
    rendererReady = false;
    appState.fallbackPending('Flavor Island renderer restarted');
    if (!quitting) {
      setTimeout(() => {
        if (quitting || win !== islandWindow) return;
        try { islandWindow.destroy(); } catch { /* already gone */ }
        createWindow();
      }, 350);
    }
  });

  // Remember where the user drags the island to. A move whose final position
  // matches the bounds we set programmatically is our own resize, not a drag —
  // ignore those so a content-driven resize can't masquerade as a user move.
  islandWindow.on('moved', () => {
    if (win !== islandWindow || islandWindow.isDestroyed()) return;
    const { x, y } = islandWindow.getBounds();
    if (lastSetBounds && x === lastSetBounds.x && y === lastSetBounds.y) return;
    userPosition = { x, y };
  });

  positionWindow(56);
}

function pushState(effects = []) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || !rendererReady) return;
  const sounds = settings.sounds
    ? effects.filter((e) => e.type === 'playSound').map((e) => e.event)
    : [];
  win.webContents.send('state-update', {
    model: renderModel(appState.snapshot(), settings),
    pending: appState.listPending(),
    sounds,
    settings,
    notch: { ...notch, flush: notchFlush },
  });
}

async function startServer() {
  server = createHookServer({
    pipe: pipePath(process.env),
    onEvent: (event) => appState.handleEvent(event),
    onPermission: (event) => appState.requestPermission(event),
    onQuestion: (event) => appState.requestQuestion(event),
    // AskUserQuestion: interactive select/type. Blocks until the user answers in
    // the island; resolves with the full PermissionRequest allow+answers object.
    onAskUserQuestion: (event) => appState.requestAskUserQuestion(event),
  });
  await server.start();
}

// If another process holds the pipe (a stale instance, or CodeIslandWin running
// on the same machine), binding fails with EADDRINUSE. Don't crash — log and
// retry in the background; the island UI keeps working and picks up events the
// moment the pipe is ours.
async function startServerWithRetry(retryMs = 10_000) {
  for (;;) {
    try {
      await startServer();
      serverStatus = 'connected';
      buildTray();
      pushSettingsStatus();
      return;
    } catch (err) {
      console.error(`hook server failed to start (${err.message}); retrying in ${retryMs}ms`);
      serverStatus = 'retrying';
      buildTray();
      pushSettingsStatus();
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'flavor.png'));
  if (!tray) tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Flavor Island');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '设置…', click: openSettingsWindow },
    { label: win && win.isVisible() ? '隐藏灵动岛' : '显示灵动岛', click: toggleIsland },
    { type: 'separator' },
    { label: '声音提醒', type: 'checkbox', checked: settings.sounds, click: (item) => updateSettings({ sounds: item.checked }) },
    { label: '开机启动', type: 'checkbox', checked: settings.launchAtLogin, click: (item) => updateSettings({ launchAtLogin: item.checked }) },
    { label: '重置位置', click: () => { if (win && !win.isDestroyed()) { userPosition = null; positionWindow(win.getBounds().height); win.show(); } } },
    { type: 'separator' },
    { label: `连接: ${serverStatus}`, enabled: false },
    { label: pluginStatus ? `插件: ${pluginStatus}` : '插件: installing…', enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function toggleIsland() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide(); else { win.show(); positionWindow(win.getBounds().height); }
  buildTray();
}

// Right-click menu on the island itself. On a notch Mac the tray icon can be
// squeezed out or hidden behind the cutout, so the island must carry its own
// escape hatch: settings, position reset, hide, and — critically — quit.
function showIslandContextMenu() {
  if (!win || win.isDestroyed()) return;
  Menu.buildFromTemplate([
    { label: '设置…', click: openSettingsWindow },
    { label: '重置位置', click: () => { userPosition = null; positionWindow(win.getBounds().height); } },
    { label: '隐藏灵动岛', click: toggleIsland },
    { type: 'separator' },
    { label: '退出 Flavor Island', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q', click: () => app.quit() },
  ]).popup({ window: win });
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try { settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))); }
  catch { settings = normalizeSettings(DEFAULT_SETTINGS); }
}

function persistSettings() {
  const target = settingsPath();
  const temp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function pushSettingsStatus() {
  if (!settingsWin || settingsWin.isDestroyed() || settingsWin.webContents.isDestroyed()) return;
  settingsWin.webContents.send('settings-state', {
    settings,
    status: { server: serverStatus, plugin: pluginStatus || 'installing', sessions: Object.keys(appState.snapshot().sessions).length },
  });
}

function updateSettings(patch) {
  const prevNotch = { mode: settings.notchMode, w: settings.notchWidth, h: settings.notchHeight };
  settings = normalizeSettings({ ...settings, ...patch, pricing: patch.pricing || settings.pricing });
  try { persistSettings(); } catch (error) { console.error(`settings save failed: ${error.message}`); }
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  buildTray();
  // Notch geometry drives window placement — re-fuse the bar to the (possibly
  // new) notch when the mode or dimensions change, otherwise the change would
  // only take effect on the next content resize.
  if (settings.notchMode !== prevNotch.mode || settings.notchWidth !== prevNotch.w || settings.notchHeight !== prevNotch.h) {
    notchFlush = 'cover';
    if (win && !win.isDestroyed()) positionWindow(win.getBounds().height);
  }
  pushState();
  pushSettingsStatus();
  return settings;
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    pushSettingsStatus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 840,
    height: 720,
    minWidth: 720,
    minHeight: 600,
    title: 'Flavor Island 设置',
    backgroundColor: '#111219',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'settings', 'index.html'));
  settingsWin.webContents.on('did-finish-load', pushSettingsStatus);
  settingsWin.on('closed', () => { settingsWin = null; });
}

// Install the flavor-code companion plugin (idempotent). It lives in
// flavor-code's global plugin dir, so every `flavor` session picks it up on
// its next start and begins relaying hook events to this app.
let pluginStatus = '';
function setupPlugin() {
  try {
    installPlugin();
    pluginStatus = 'installed';
  } catch (err) {
    pluginStatus = `install failed (${err.message})`;
    console.error(`flavor-code plugin install failed: ${err.message}`);
  }
}

app.whenReady().then(async () => {
  // macOS accessory app: the island lives in the menu-bar layer, not the Dock.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  loadSettings();
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  setupPlugin();
  createWindow();
  buildTray();
  // Fire-and-forget: keep retrying until the pipe binds (see startServerWithRetry).
  startServerWithRetry();

  appState.subscribe((_, effects) => {
    pushState(effects);
    pushSettingsStatus();
  });
  pushState();

  const keepIslandVisible = () => {
    if (!win || win.isDestroyed()) return;
    // Display topology changed (notch screen plugged/unplugged, resolution
    // switch): re-probe whether we can cover the notch from scratch.
    notchFlush = 'cover';
    positionWindow(win.getBounds().height);
  };
  screen.on('display-added', keepIslandVisible);
  screen.on('display-removed', keepIslandVisible);
  screen.on('display-metrics-changed', keepIslandVisible);

  setInterval(() => appState.cleanupIdle(), 30 * 1000);
});

// The renderer measures its own layout and reports the needed size. In notch
// mode the width matters too (bar/panel are content-sized, not the fixed
// Windows width), so payload is { height, width }.
ipcMain.on('resize', (_evt, payload) => {
  if (typeof payload === 'number') positionWindow(payload);
  else positionWindow(payload.height, payload.width);
});
// Renderer hit-test result: ignore mouse events (pass clicks through to whatever
// is underneath) everywhere except over the pill/panel. forward:true so we keep
// receiving move events to re-arm when the cursor returns to content.
ipcMain.on('set-ignore-mouse', (_evt, ignore) => {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});
// Manual drag from the renderer: remember the new top-left and apply it (height
// stays whatever the content currently needs).
ipcMain.on('move-window', (_evt, { x, y }) => {
  if (!win || win.isDestroyed()) return;
  userPosition = { x: Math.round(x), y: Math.round(y) };
  positionWindow(win.getBounds().height);
});
// Double-click on the pill: forget the dragged position and snap back to the
// default top-center spot, keeping the current height.
ipcMain.on('reset-position', () => {
  if (!win || win.isDestroyed()) return;
  userPosition = null;
  positionWindow(win.getBounds().height);
});
// Right-click anywhere on the island (bar or panel) pops the native menu with
// the quit entry — the only escape hatch that works even when the tray icon
// is hidden behind the notch.
ipcMain.on('island-contextmenu', () => showIslandContextMenu());
ipcMain.on('permission-decision', (_evt, { key, behavior }) => appState.resolvePermission(key, behavior));
ipcMain.on('question-answer', (_evt, { key, answer }) => appState.resolveQuestion(key, answer));
ipcMain.on('ask-answer', (_evt, { key, answers, details }) => appState.resolveAskUserQuestion(key, answers, details));
ipcMain.on('ask-skip', (_evt, { key }) => appState.skipAskUserQuestion(key));
ipcMain.handle('settings-get', () => ({
  settings,
  status: { server: serverStatus, plugin: pluginStatus || 'installing', sessions: Object.keys(appState.snapshot().sessions).length },
}));
ipcMain.handle('settings-save', (_evt, value) => updateSettings(value || {}));
ipcMain.handle('settings-reset', () => updateSettings(DEFAULT_SETTINGS));
ipcMain.handle('settings-open', () => { openSettingsWindow(); return true; });

// ---- flavor-code GLOBAL.md management ---------------------------------
// flavor-code injects GLOBAL.md verbatim and recognizes rules as single-line
// `- ` bullets (contract mirrored in src/core/globalRules.js). It has no
// per-rule switch, so "disabled" rules must physically leave the file; the
// island keeps them in its own sidecar so toggling moves them back.
function globalPaths() {
  const dir = path.join(os.homedir(), '.flavor-code');
  return { dir, file: path.join(dir, 'GLOBAL.md'), sidecar: path.join(dir, 'GLOBAL.disabled.json') };
}

function readGlobalDoc(p) {
  try { return fs.readFileSync(p.file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

function readDisabledRules(p) {
  let raw;
  try { raw = fs.readFileSync(p.sidecar, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('disabled-rules sidecar is not an array');
  return list.filter((x) => typeof x === 'string');
}

function writeGlobalFile(p, target, content) {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(target, content);
}

const sameRule = (a, b) => String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase();

ipcMain.handle('global-list', () => {
  const p = globalPaths();
  const rules = parseRuleLines(readGlobalDoc(p)).map((r) => ({ text: r.text, enabled: true }));
  const disabled = readDisabledRules(p).map((t) => ({ text: t, enabled: false }));
  return { rules: [...rules, ...disabled], path: p.file };
});

ipcMain.handle('global-add', (_evt, text) => {
  const p = globalPaths();
  writeGlobalFile(p, p.file, addRule(readGlobalDoc(p), text));
  // A fresh add supersedes any disabled twin of the same rule.
  const disabled = readDisabledRules(p);
  const next = disabled.filter((t) => !sameRule(t, text));
  if (next.length !== disabled.length) writeGlobalFile(p, p.sidecar, `${JSON.stringify(next, null, 2)}\n`);
});

ipcMain.handle('global-update', (_evt, { text, newText } = {}) => {
  const p = globalPaths();
  const doc = readGlobalDoc(p);
  if (parseRuleLines(doc).some((r) => sameRule(r.text, text))) {
    writeGlobalFile(p, p.file, updateRule(doc, text, newText));
    return;
  }
  const disabled = readDisabledRules(p);
  const idx = disabled.findIndex((t) => sameRule(t, text));
  if (idx < 0) throw new Error(`no rule matches: ${text}`);
  disabled[idx] = validateRule(newText);
  writeGlobalFile(p, p.sidecar, `${JSON.stringify(disabled, null, 2)}\n`);
});

ipcMain.handle('global-delete', (_evt, text) => {
  const p = globalPaths();
  writeGlobalFile(p, p.file, removeRule(readGlobalDoc(p), text));
  const disabled = readDisabledRules(p);
  const next = disabled.filter((t) => !sameRule(t, text));
  if (next.length !== disabled.length) writeGlobalFile(p, p.sidecar, `${JSON.stringify(next, null, 2)}\n`);
});

ipcMain.handle('global-toggle', (_evt, { text, on } = {}) => {
  const p = globalPaths();
  if (on) {
    const disabled = readDisabledRules(p).filter((t) => !sameRule(t, text));
    writeGlobalFile(p, p.sidecar, `${JSON.stringify(disabled, null, 2)}\n`);
    const doc = readGlobalDoc(p);
    if (!parseRuleLines(doc).some((r) => sameRule(r.text, text))) writeGlobalFile(p, p.file, addRule(doc, text));
  } else {
    const doc = readGlobalDoc(p);
    const match = parseRuleLines(doc).find((r) => sameRule(r.text, text));
    if (match) {
      writeGlobalFile(p, p.file, removeRule(doc, text));
      const disabled = readDisabledRules(p);
      if (!disabled.some((t) => sameRule(t, text))) {
        disabled.push(validateRule(match.text));
        writeGlobalFile(p, p.sidecar, `${JSON.stringify(disabled, null, 2)}\n`);
      }
    }
  }
});
ipcMain.handle('session-control', async (_evt, { sessionId, command, message } = {}) => {
  const session = appState.snapshot().sessions[sessionId];
  if (!session) throw new Error('Session is no longer available');
  if (!session.controlCapabilities.includes(command)) throw new Error('This control is not supported by the session');
  return sendControlCommand({
    endpoint: session.controlEndpoint,
    token: session.controlToken,
    command,
    message,
  });
});
ipcMain.on('quit', () => app.quit());

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('before-quit', async () => {
  quitting = true;
  appState.fallbackPending('Flavor Island is quitting');
  if (server) await server.stop();
});
