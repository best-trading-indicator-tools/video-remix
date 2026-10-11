import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withSetupLock } from './setup-lock.mjs';

const exec = promisify(execFile);
export const projectRoot = process.env.REMIX_RUNTIME_DIR || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const pythonDirectory = root => path.join(root, '.remix-python');
const check = 'import sys, struct, venv, ensurepip; assert sys.version_info[:2] == (3, 12); assert struct.calcsize("P") == 8';

/** A relative path keeps a downloaded interpreter discoverable if the checkout moves. */
export async function managedPython(root = projectRoot) {
  const directory = pythonDirectory(root);
  try {
    const { executable } = JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8'));
    if (typeof executable !== 'string' || path.isAbsolute(executable)) return;
    const candidate = path.resolve(directory, executable);
    if (!candidate.startsWith(path.join(directory, 'python') + path.sep)) return;
    await access(candidate);
    return candidate;
  } catch { /* Missing, incomplete or moved installation: set it up again. */ }
}

export function privatePythonEnvironment(root, env = process.env) {
  const directory = pythonDirectory(root);
  const result = { ...env, UV_PYTHON_INSTALL_DIR: path.join(directory, 'python'),
    UV_PYTHON_BIN_DIR: path.join(directory, 'bin'), UV_CACHE_DIR: path.join(directory, 'cache'),
    UV_PYTHON_PREFERENCE: 'only-managed' };
  // An activated environment must not redirect discovery or poison a new interpreter.
  for (const key of ['VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONHOME', 'PYTHONPATH']) delete result[key];
  return result;
}

export function verifyPythonInstaller(bytes, expected) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Python installer checksum mismatch. Retry setup to download a fresh copy.');
}

async function findBinary(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) return path.join(directory, name);
    if (entry.isDirectory()) { const found = await findBinary(path.join(directory, entry.name), name); if (found) return found; }
  }
}

/** Install a pinned uv binary and a private Python, without PATH or registry changes. */
export async function ensureManagedPython({ root = projectRoot, report = console.log } = {}) {
  root = await realpath(root);
  const directory = pythonDirectory(root);
  const env = privatePythonEnvironment(root);
  const run = (command, args) => exec(command, args, { cwd: root, env, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  const existing = async () => {
    const python = await managedPython(root);
    if (python) {
      try { await run(python, ['-I', '-c', check]); return python; } catch { /* Repair below. */ }
    }
  };
  const ready = await existing();
  if (ready) { report('Private Python 3.12 is ready.'); return ready; }
  const manifest = JSON.parse(await readFile(path.join(root, 'desktop/assets.json'), 'utf8'));
  const asset = manifest.uv[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error('Automatic Python setup supports Windows x64, Linux x64 and Apple Silicon. Set PYTHON_BIN to a supported Python executable on other systems.');
  await mkdir(directory, { recursive: true });
  return withSetupLock(path.join(directory, 'setup-lock'), async () => {
    const ready = await existing();
    if (ready) return ready;
    const temporary = await mkdtemp(path.join(directory, 'download-'));
    try {
      report('Downloading the verified Python installer…');
      const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${manifest.uvVersion}/${asset.name}`,
        { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Python installer download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      verifyPythonInstaller(bytes, asset.sha256);
      const archive = path.join(temporary, asset.name);
      await writeFile(archive, bytes);
      if (asset.name.endsWith('.zip')) {
        const { default: extractZip } = await import('extract-zip');
        await extractZip(archive, { dir: temporary });
      } else await run('tar', ['-xzf', archive, '-C', temporary]);
      const binary = process.platform === 'win32' ? 'uv.exe' : 'uv';
      const unpacked = await findBinary(temporary, binary);
      if (!unpacked) throw new Error('The verified Python installer archive is incomplete.');
      const uv = path.join(directory, 'bin', binary);
      await mkdir(path.dirname(uv), { recursive: true });
      await copyFile(unpacked, uv); await chmod(uv, 0o755);
      report('Installing private Python 3.12… This first download may take a few minutes.');
      await run(uv, ['python', 'install', '3.12', '--no-bin', '--no-registry', '--no-config', '--reinstall']);
      const found = await run(uv, ['python', 'find', '3.12', '--no-project', '--no-config']);
      const python = await realpath(found.stdout.trim());
      const relative = path.relative(directory, python);
      if (!relative.startsWith('python' + path.sep)) throw new Error('Python was installed outside the private runtime.');
      await run(python, ['-I', '-c', check]);
      const marker = path.join(directory, `ready-${randomUUID()}.tmp`);
      await writeFile(marker, JSON.stringify({ executable: relative }));
      await rename(marker, path.join(directory, 'ready.json'));
      report('Private Python 3.12 is ready. Local tool setup will use it automatically.');
      return python;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }, () => report('Waiting for private Python setup…'), 'Python');
}
