'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('node:path');
const { createAppState } = require('./appState');
const { createHookServer } = require('../server/hookServer');
const { renderModel } = require('../core/renderModel');
const { computeWindowBounds } = require('../core/windowLayout');
const { pipePath } = require('../core/pipePath');
const { installPlugin } = require('./pluginInstaller');

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
let server = null;
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

function positionWindow(height) {
  if (!win) return;
  const display = screen.getPrimaryDisplay();
  // Never let the island grow past the bottom of the screen — clamp to the work
  // area and let the panel scroll internally for content that doesn't fit.
  const bounds = computeWindowBounds(height, {
    workArea: display.workArea,
    width: WIN_WIDTH,
    topMargin: TOP_MARGIN,
    min: 1,
    userPosition,
  });
  // Skip no-op resizes: re-applying identical bounds forces a window redraw,
  // which shows up as a flicker on the transparent always-on-top window.
  const cur = win.getBounds();
  if (cur.x === bounds.x && cur.y === bounds.y && cur.width === bounds.width && cur.height === bounds.height) return;
  lastSetBounds = bounds;
  win.setBounds(bounds);
}

function createWindow() {
  win = new BrowserWindow({
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // A transparent window still swallows clicks on every pixel, so the fixed-width
  // island would block the mostly-empty area around the pill. Start fully
  // click-through; the renderer re-arms us (set-ignore-mouse) only while the
  // cursor is over visible content. forward:true keeps move events flowing so the
  // renderer can detect re-entry.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    // Render whatever state accumulated while the page was loading.
    pushState();
  });
  win.webContents.on('render-process-gone', () => { rendererReady = false; });

  // Remember where the user drags the island to. A move whose final position
  // matches the bounds we set programmatically is our own resize, not a drag —
  // ignore those so a content-driven resize can't masquerade as a user move.
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const { x, y } = win.getBounds();
    if (lastSetBounds && x === lastSetBounds.x && y === lastSetBounds.y) return;
    userPosition = { x, y };
  });

  positionWindow(56);
}

function pushState(effects = []) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || !rendererReady) return;
  const sounds = effects.filter((e) => e.type === 'playSound').map((e) => e.event);
  win.webContents.send('state-update', {
    model: renderModel(appState.snapshot()),
    pending: appState.listPending(),
    sounds,
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
      return;
    } catch (err) {
      console.error(`hook server failed to start (${err.message}); retrying in ${retryMs}ms`);
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'flavor.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Flavor Island');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Reset position', click: () => { if (win && !win.isDestroyed()) { userPosition = null; positionWindow(win.getBounds().height); } } },
    { label: pluginStatus ? `Plugin: ${pluginStatus}` : 'Plugin: installing…', enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
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

  setupPlugin();
  createWindow();
  buildTray();
  // Fire-and-forget: keep retrying until the pipe binds (see startServerWithRetry).
  startServerWithRetry();

  appState.subscribe((_, effects) => pushState(effects));
  pushState();

  setInterval(() => appState.cleanupIdle(), 30 * 1000);
});

ipcMain.on('resize', (_evt, height) => positionWindow(height));
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
ipcMain.on('permission-decision', (_evt, { key, behavior }) => appState.resolvePermission(key, behavior));
ipcMain.on('question-answer', (_evt, { key, answer }) => appState.resolveQuestion(key, answer));
ipcMain.on('ask-answer', (_evt, { key, answers, details }) => appState.resolveAskUserQuestion(key, answers, details));
ipcMain.on('ask-skip', (_evt, { key }) => appState.skipAskUserQuestion(key));
ipcMain.on('quit', () => app.quit());

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('before-quit', async () => { if (server) await server.stop(); });
