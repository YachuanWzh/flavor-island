'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flavorSettings', {
  get: () => ipcRenderer.invoke('settings-get'),
  save: (settings) => ipcRenderer.invoke('settings-save', settings),
  reset: () => ipcRenderer.invoke('settings-reset'),
  onState: (callback) => ipcRenderer.on('settings-state', (_event, value) => callback(value)),
  global: {
    list: () => ipcRenderer.invoke('global-list'),
    add: (text) => ipcRenderer.invoke('global-add', text),
    update: (text, newText) => ipcRenderer.invoke('global-update', { text, newText }),
    remove: (text) => ipcRenderer.invoke('global-delete', text),
    toggle: (text, on) => ipcRenderer.invoke('global-toggle', { text, on }),
  },
});
