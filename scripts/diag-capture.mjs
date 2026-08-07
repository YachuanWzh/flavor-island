// Diagnostic: temporarily run the real app and capture the window contents to
// a PNG so we can see whether the transparent window actually renders content
// under software compositing. Prints a line of text instead of the capture for
// the main process, and also saves any console errors.
//
// Approach: we can't capture the *running* app's window from outside. Instead
// this launches a *second* electron entry that reuses the app's source but with
// capture enabled — but the single-instance lock blocks it. So we temporarily
// set env FLAVOR_ISLAND_CAPTURE=1, which the app main reads to capture+quit.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Patch main.js? No — instead run a one-off electron script that requires the
// real main modules but creates its own window with capture. Simpler: use a
// dedicated capture entry that mimics createWindow.
const captureEntry = `
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 420, height: 56, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, alwaysOnTop: true,
    hasShadow: false, fullscreenable: false,
    webPreferences: { preload: path.join(process.cwd(), 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', async () => {
    await sleep(1500);
    const img = await win.webContents.capturePage();
    writeFileSync(process.cwd() + '/scripts/_capture.png', img.toPNG());
    const isVisible = win.isVisible();
    const bounds = win.getBounds();
    console.log('CAPTURED visible=' + isVisible + ' bounds=' + JSON.stringify(bounds));
    app.quit();
  });
});
`;
writeFileSync('scripts/_capture-entry.js', captureEntry);

const electronBin = 'node_modules\\electron\\dist\\electron.exe';
const child = spawn(electronBin, ['scripts/_capture-entry.js'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', (d) => { console.log(d.toString().trim()); });
child.on('exit', (code) => {
  console.log('capture entry exited', code);
  if (stderr.trim()) console.log('stderr:', stderr.trim().split('\n').slice(-6).join('\n'));
  try {
    const b = readFileSync('scripts/_capture.png');
    console.log('capture.png bytes:', b.length);
  } catch { console.log('no capture.png written'); }
});
