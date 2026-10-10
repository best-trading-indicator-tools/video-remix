const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('remixDesktop', {
  getState: () => ipcRenderer.invoke('setup:state'),
  openSetup: () => ipcRenderer.invoke('setup:open'),
  openStudio: () => ipcRenderer.invoke('setup:studio'),
  install: ids => ipcRenderer.invoke('setup:install', ids),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('setup:state', listener); return () => ipcRenderer.removeListener('setup:state', listener); },
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdate: () => ipcRenderer.invoke('updates:open'),
  onUpdateState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('updates:state', listener); return () => ipcRenderer.removeListener('updates:state', listener); },
});
