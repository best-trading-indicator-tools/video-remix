import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const components = [
  { id: 'imports', name: 'Video links', description: 'Import video URLs and use the free Downloader.', script: 'setup-imports.mjs', recommended: true },
  { id: 'speech', name: 'Local captions & transcription', description: 'Recognize speech on this computer. Downloads the speech model once.', script: 'setup-auto.mjs', recommended: true },
  { id: 'upscale', name: 'Free AI upscaler', description: 'Real-ESRGAN for 1080p to 4K. Larger download; GPU acceleration when supported.', script: 'setup-upscale.mjs', recommended: true },
  { id: 'ocr', name: 'Detect existing captions', description: 'English and French OCR models. Helps avoid adding captions over existing ones.', recommended: false },
  { id: 'graphics', name: 'Animated cards', description: 'Download the local renderer for animated explainers and supporting visuals.', recommended: false },
  { id: 'focus', name: 'Face framing', description: 'Follow faces while reframing your videos.', script: 'setup-focus.mjs', recommended: false },
  { id: 'watermark', name: 'Local object removal', description: 'Optional LaMa model for cleaning marked areas.', script: 'setup-watermark.mjs', recommended: false },
];
export function desktopEnvironment(root, runtime, data, binaries, executable = process.execPath) {
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', REMIX_RUNTIME_DIR: runtime,
    REMIX_OCR_SCRIPT: path.join(root, 'desktop/ocr.cjs'), REMIX_DESKTOP: '1',
    DATA_DIR: data, HOST: '127.0.0.1', PORT: '0',
    PATH: `${binaries}${path.delimiter}${process.env.PATH || ''}`, REMIX_NODE: executable,
    UV_PYTHON_INSTALL_DIR: path.join(runtime, 'python'), UV_PYTHON_PREFERENCE: 'only-managed',
    UV_CACHE_DIR: path.join(runtime, 'uv-cache'), PYTHONUNBUFFERED: '1',
    HF_HUB_DISABLE_TELEMETRY: '1', WHISPER_CACHE_DIR: path.join(data, 'models'),
    PUPPETEER_CACHE_DIR: path.join(runtime, 'browsers'),
  };
}
export async function prepareRuntime(root, runtime) {
  await mkdir(runtime, { recursive: true });
  // Copy only bundled, public runtime files. Never copy a developer's workspace or secrets.
  await cp(path.join(root, 'scripts'), path.join(runtime, 'scripts'), { recursive: true,
    filter: source => !/[/\\](?:__pycache__|models)(?:[/\\]|$)/u.test(source) || source.endsWith('models') });
  for (const name of await readdir(root)) if (/^requirements-[\w-]+\.txt$/u.test(name)) await cp(path.join(root, name), path.join(runtime, name));
  await cp(path.join(root, 'dist'), path.join(runtime, 'dist'), { recursive: true });
}
export function run(command, args, { cwd, env, signal, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Installation cancelled.'));
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', pending = '', killTimer;
    const receive = chunk => {
      const text = chunk.toString(); output = (output + text).slice(-32_000); pending += text;
      const lines = pending.split(/[\r\n]+/u); pending = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine(line.slice(0, 500));
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 2000);
        killTimer.unref();
      }
    };
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', error => { clearTimeout(killTimer); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop); if (pending.trim()) onLine(pending.slice(0, 500));
      if (signal?.aborted) reject(new Error('Installation cancelled. You can retry at any time.'));
      else if (code !== 0) reject(new Error('Installation failed. Check the details and your internet connection, then retry.'));
      else resolve(output.trim());
    });
  });
}
export async function installComponents(ids, context) {
  if (!Array.isArray(ids) || !ids.length || ids.length > components.length || ids.some(id => !components.some(item => item.id === id)) || new Set(ids).size !== ids.length)
    throw new Error('Choose valid local tools to install.');
  const { root, runtime, env, executable, signal, onProgress } = context;
  const selected = components.filter(item => ids.includes(item.id));
  const logs = [];
  const report = (phase, completed, line) => {
    if (line) { logs.push(line); if (logs.length > 60) logs.shift(); }
    onProgress({ phase, completed, total: selected.length + 1, logs: [...logs] });
  };
  const options = { cwd: runtime, env, signal, onLine: line => report('Preparing Python', 0, line) };
  let python = '';
  if (selected.some(item => item.script)) {
    await run('uv', ['python', 'install', '3.12'], options);
    python = (await run('uv', ['python', 'find', '3.12'], options)).split(/\r?\n/u).at(-1);
    await access(python);
  }
  let completed = 1;
  for (const item of selected) {
    report(`Installing ${item.name}`, completed);
    const args = item.script ? [path.join(runtime, 'scripts', item.script)] : item.id === 'graphics'
      ? [path.join(root, 'desktop/graphics.mjs')] : [path.join(root, 'desktop/ocr.cjs'), '--download'];
    await run(executable, args, { cwd: runtime, env: { ...env, ...(python ? { PYTHON_BIN: python } : {}) }, signal,
      onLine: line => report(`Installing ${item.name}`, completed, line) });
    await writeFile(path.join(runtime, `ready-${item.id}.json`), JSON.stringify({ checkedAt: new Date().toISOString() }));
    completed++; report(`${item.name} ready`, completed);
  }
}
export async function componentState(runtime) {
  return Promise.all(components.map(async item => {
    let ready = false;
    try { await readFile(path.join(runtime, `ready-${item.id}.json`)); ready = true; } catch { /* Not installed yet. */ }
    return { ...item, ready };
  }));
}
