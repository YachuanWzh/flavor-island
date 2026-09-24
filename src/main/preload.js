'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flavorIsland', {
  // The sandboxed renderer has no `process`; ⌘Q-vs-Ctrl+Q needs the platform.
  platform: process.platform,
  onState: (cb) => ipcRenderer.on('state-update', (_e, payload) => cb(payload)),
  resize: (height, width = null) => ipcRenderer.send('resize', { height, width }),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  resetPosition: () => ipcRenderer.send('reset-position'),
  decide: (key, behavior) => ipcRenderer.send('permission-decision', { key, behavior }),
  answer: (key, answer) => ipcRenderer.send('question-answer', { key, answer }),
  answerQuestions: (key, answers, details) => ipcRenderer.send('ask-answer', { key, answers, details }),
  skipQuestions: (key) => ipcRenderer.send('ask-skip', { key }),
  control: (sessionId, command, message) => ipcRenderer.invoke('session-control', { sessionId, command, message }),
  openSettings: () => ipcRenderer.invoke('settings-open'),
  quit: () => ipcRenderer.send('quit'),
  showContextMenu: () => ipcRenderer.send('island-contextmenu'),
});
