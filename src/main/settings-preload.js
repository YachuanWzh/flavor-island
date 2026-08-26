'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flavorSettings', {
  get: () => ipcRenderer.invoke('settings-get'),
  save: (settings) => ipcRenderer.invoke('settings-save', settings),
  reset: () => ipcRenderer.invoke('settings-reset'),
  onState: (callback) => ipcRenderer.on('settings-state', (_event, value) => callback(value)),
});
