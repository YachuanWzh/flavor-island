'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.disableHardwareAcceleration();
for (const value of ['disable-gpu', 'disable-gpu-compositing', 'disable-gpu-sandbox', 'no-sandbox']) app.commandLine.appendSwitch(value);
app.whenReady().then(async () => {
  const sample = { settings: { sounds: true, autoExpand: true, launchAtLogin: false, motion: 'system', privacyMode: true, pricing: { inputPerMillion: 1.5, outputPerMillion: 6, cacheReadPerMillion: .3, cacheCreationPerMillion: 1.8 } }, status: { server: 'connected', plugin: 'installed', sessions: 1 } };
  ipcMain.handle('settings-get', () => sample); ipcMain.handle('settings-save', (_e, value) => value); ipcMain.handle('settings-reset', () => sample.settings);
  const win = new BrowserWindow({ width: 840, height: 720, show: false, backgroundColor: '#0f1116', webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'settings-preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'settings', 'index.html')); await new Promise((resolve) => setTimeout(resolve, 600));
  const image = await win.webContents.capturePage(); const output = path.join(__dirname, '..', '.artifacts', 'settings-icons.png');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, image.toPNG()); console.log(output); app.quit();
});
