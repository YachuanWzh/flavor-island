'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flavorIsland', {
  onState: (cb) => ipcRenderer.on('state-update', (_e, payload) => cb(payload)),
  resize: (height) => ipcRenderer.send('resize', height),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  resetPosition: () => ipcRenderer.send('reset-position'),
  decide: (key, behavior) => ipcRenderer.send('permission-decision', { key, behavior }),
  answer: (key, answer) => ipcRenderer.send('question-answer', { key, answer }),
  answerQuestions: (key, answers, details) => ipcRenderer.send('ask-answer', { key, answers, details }),
  skipQuestions: (key) => ipcRenderer.send('ask-skip', { key }),
  quit: () => ipcRenderer.send('quit'),
});
