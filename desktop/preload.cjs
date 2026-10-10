const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('remixDesktop', {
  getState: () => ipcRenderer.invoke('setup:state'),
  openSetup: () => ipcRenderer.invoke('setup:open'),
  openStudio: () => ipcRenderer.invoke('setup:studio'),
  install: ids => ipcRenderer.invoke('setup:install', ids),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('setup:state', listener); return () => ipcRenderer.removeListener('setup:state', listener); },
});
