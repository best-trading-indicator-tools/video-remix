exports.workspaceEditMenu = window => ({ label: 'Edit', submenu: [
  { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => window.webContents.send('workspace:history', 'undo') },
  { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => window.webContents.send('workspace:history', 'redo') },
  { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
] });
