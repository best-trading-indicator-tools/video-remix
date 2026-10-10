const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { access, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (process.env.REMIX_DESKTOP_TEST_HOME) app.setPath('userData', process.env.REMIX_DESKTOP_TEST_HOME);
if (!app.requestSingleInstanceLock()) app.quit();
let window, engine, installer, runtimeApi, context, origin, updateChecker, quitting = false, stopping = false;
let state = { busy: false, phase: 'Checking bundled tools', completed: 0, total: 1, logs: [], components: [], engineReady: false, error: '' };
const root = path.resolve(__dirname, '..');
const setupUrl = pathToFileURL(path.join(__dirname, 'welcome.html')).href;
const token = randomBytes(32).toString('hex');
const publish = patch => { state = { ...state, ...patch }; if (window && !window.isDestroyed()) window.webContents.send('setup:state', state); };
const trusted = event => {
  const url = event.senderFrame?.url;
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !(url === setupUrl || origin && new URL(url).origin === origin))
    throw new Error('Open Local tools in Remix Studio.');
};
const setup = async () => { await window.loadURL(setupUrl); };
const external = url => {
  try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) void shell.openExternal(parsed.href); } catch { /* Ignore unknown protocols. */ }
};
async function startEngine() {
  if (engine) return;
  const child = spawn(process.execPath, [path.join(root, 'dist-server/server/index.js')], {
    cwd: context.runtime, env: { ...context.env, REMIX_DESKTOP_TOKEN: token }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  engine = child;
  child.stderr.on('data', () => {}); child.stdout.on('data', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local engine took too long to start. Restart Remix Studio.')), 30_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start the bundled local engine.')); });
    child.on('message', message => {
      if (message?.type !== 'ready' || !Number.isSafeInteger(message.port) || message.port < 1 || message.port > 65535) return;
      origin = `http://127.0.0.1:${message.port}`; clearTimeout(timer);
      // A stable origin preserves browser drafts, preferences and tour completion.
      writeFile(path.join(context.runtime, 'engine-port'), String(message.port), { mode: 0o600 })
        .then(() => { publish({ engineReady: true }); resolve(); }, reject);
    });
    child.once('exit', () => {
      clearTimeout(timer); engine = undefined; publish({ engineReady: false });
      if (!quitting) { publish({ error: 'The local engine stopped. Restart Remix Studio to continue.' }); void setup(); }
      reject(new Error('The local engine could not start.'));
    });
  });
}
async function initialize() {
  runtimeApi = await import('./runtime.mjs');
  const runtime = path.join(app.getPath('userData'), 'engine');
  const data = path.join(app.getPath('userData'), 'workspace');
  const binaries = app.isPackaged ? path.join(process.resourcesPath, 'tools/bin') : path.join(__dirname, 'resources/bin');
  context = { root, runtime, executable: process.execPath, env: runtimeApi.desktopEnvironment(root, runtime, data, binaries) };
  publish({ phase: 'Preparing your private workspace' });
  await runtimeApi.prepareRuntime(root, runtime);
  try {
    const port = Number(await readFile(path.join(runtime, 'engine-port'), 'utf8'));
    if (Number.isInteger(port) && port > 1024 && port <= 65535) context.env.PORT = String(port);
  } catch { /* Allocate a free port on first launch. */ }
  for (const binary of ['ffmpeg', 'ffprobe', 'uv']) await runtimeApi.run(path.join(binaries, binary + (process.platform === 'win32' ? '.exe' : '')), ['-version'].map(flag => binary === 'uv' ? '--version' : flag), { cwd: runtime, env: context.env });
  await startEngine();
  publish({ phase: 'Ready for local editing', completed: 1, components: await runtimeApi.componentState(runtime) });
  try { await access(path.join(runtime, 'welcome-complete')); await window.loadURL(origin); } catch { /* First launch stays in setup. */ }
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 860, minHeight: 620, backgroundColor: '#101216', title: 'Remix Studio',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (origin && new URL(details.url).origin === origin) details.requestHeaders['X-Remix-Desktop'] = token;
    callback({ requestHeaders: details.requestHeaders });
  });
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== setupUrl && (!origin || new URL(url).origin !== origin)) { event.preventDefault(); external(url); }
  });
  ipcMain.handle('setup:state', event => { trusted(event); return state; });
  const { createUpdateChecker, fetchPublishedReleases } = await import('./updates.mjs');
  updateChecker = createUpdateChecker({ currentVersion: app.getVersion(), fetchReleases: fetchPublishedReleases,
    onChange: value => { if (!window.isDestroyed()) window.webContents.send('updates:state', value); } });
  ipcMain.handle('updates:state', event => { trusted(event); return updateChecker.getState(); });
  ipcMain.handle('updates:check', event => { trusted(event); return updateChecker.check(true); });
  ipcMain.handle('updates:open', async event => {
    trusted(event);
    const release = updateChecker.getState().release;
    if (!release) throw new Error('Check for an available update first.');
    await shell.openExternal(release.url);
  });
  ipcMain.handle('setup:open', async event => { trusted(event); publish({ components: await runtimeApi.componentState(context.runtime) }); await setup(); });
  ipcMain.handle('setup:studio', async event => { trusted(event); if (!origin || !state.engineReady) throw new Error('The local engine is still starting.'); await writeFile(path.join(context.runtime, 'welcome-complete'), '1'); await window.loadURL(origin); });
  ipcMain.handle('setup:cancel', event => { trusted(event); installer?.abort(); });
  ipcMain.handle('setup:install', async (event, ids) => {
    trusted(event); if (!context || state.busy) throw new Error('Wait for the current setup to finish.');
    installer = new AbortController(); publish({ busy: true, error: '', logs: [], completed: 0, phase: 'Starting setup' });
    try {
      await runtimeApi.installComponents(ids, { ...context, signal: installer.signal, onProgress: publish });
      publish({ phase: 'Selected tools are ready' });
    } catch (error) { publish({ error: error.message, phase: installer.signal.aborted ? 'Setup cancelled' : 'Setup needs attention' }); }
    finally { installer = undefined; publish({ busy: false, components: await runtimeApi.componentState(context.runtime) }); }
    return state;
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Local tools', click: () => void setup() }, { role: 'close' }] },
    { role: 'editMenu' }, { role: 'viewMenu' },
  ]));
  await setup();
  if (app.isPackaged) {
    void updateChecker.check();
    const updateTimer = setInterval(() => void updateChecker.check(), 6 * 60 * 60 * 1000);
    updateTimer.unref();
  }
  try { await initialize(); } catch (error) { publish({ error: error.message, phase: 'Setup needs attention' }); }
});
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (stopping) return;
  event.preventDefault(); quitting = true; installer?.abort();
  const finish = () => { stopping = true; app.quit(); };
  if (!engine) { finish(); return; }
  engine.once('exit', finish); engine.send({ type: 'shutdown' });
  const timer = setTimeout(() => { engine?.kill(); finish(); }, 15_000); timer.unref();
});
