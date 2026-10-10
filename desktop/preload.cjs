const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('remixDesktop', {
  editTextHistory: direction => ipcRenderer.invoke('workspace:text-history', direction),
  onHistory: callback => { const listener = (_event, direction) => callback(direction); ipcRenderer.on('workspace:history', listener); return () => ipcRenderer.removeListener('workspace:history', listener); },
  notifyBatch: body => ipcRenderer.invoke('batches:notify', body),
  onOpenExports: callback => { const listener = () => callback(); ipcRenderer.on('batches:open', listener); return () => ipcRenderer.removeListener('batches:open', listener); },
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
