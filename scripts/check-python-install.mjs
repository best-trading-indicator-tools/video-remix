import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(path.join(tmpdir(), 'remix npm install '));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run check:python-install');
try {
  await mkdir(path.join(directory, 'scripts')); await mkdir(path.join(directory, 'desktop'));
  for (const name of ['setup-python-runtime.mjs', 'python-runtime.mjs', 'setup-python.mjs', 'setup-lock.mjs'])
    await cp(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
  await cp(path.join(root, 'desktop/assets.json'), path.join(directory, 'desktop/assets.json'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'remix-python-smoke', private: true,
    scripts: { postinstall: pkg.scripts.postinstall }, dependencies: { 'extract-zip': pkg.dependencies['extract-zip'] } }));
  const bin = path.join(directory, 'system-tools'); await mkdir(bin);
  if (process.platform !== 'win32') {
    await symlink('/usr/bin/tar', path.join(bin, 'tar'));
    await symlink('/usr/bin/gzip', path.join(bin, 'gzip'));
    await symlink('/bin/sh', path.join(bin, 'sh'));
  }
  // npm gets Node and an archive tool, with no system Python or uv on PATH.
  const env = { ...process.env, PATH: [path.dirname(process.execPath), bin,
    ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [])].join(path.delimiter),
    PYTHON_BIN: '', REMIX_RUNTIME_DIR: directory, REMIX_SKIP_PYTHON_SETUP: '',
    npm_config_ignore_scripts: 'false', UV_OFFLINE: 'false', UV_PYTHON_DOWNLOADS: 'automatic' };
  const run = (command, args, extraEnv = {}) => exec(command, args, { cwd: directory, env: { ...env, ...extraEnv },
    windowsHide: true, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
  const installed = await run(process.execPath, [npm, 'install', '--omit=dev', '--no-audit', '--no-fund']);
  console.log(installed.stdout);
  const { managedPython } = await import(pathToFileURL(path.join(directory, 'scripts/python-runtime.mjs')).href);
  const python = await managedPython(directory);
  assert.ok(python, `npm install must produce a private Python runtime.\n${installed.stderr}`);
  const { findPython } = await import(pathToFileURL(path.join(directory, 'scripts/setup-python.mjs')).href);
  const selected = await findPython(async (command, args) => {
    assert.equal(command, python, 'Setup must use private Python without searching PATH');
    await run(command, args);
  }, { root: directory, pythonBin: undefined });
  assert.equal(selected.command, python);
  const venv = path.join(directory, 'test venv');
  await run(python, ['-m', 'venv', venv]);
  const venvPython = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await run(venvPython, ['-m', 'pip', '--version']);
  const marker = path.join(directory, '.remix-python/ready.json');
  const before = (await stat(marker)).mtimeMs;
  const again = await run(process.execPath, [npm, 'ci', '--omit=dev', '--offline', '--no-audit', '--no-fund'], { UV_OFFLINE: '1' });
  assert.match(again.stdout, /Private Python 3.12 is ready/);
  assert.equal((await stat(marker)).mtimeMs, before, 'Offline reinstall reuses the checked runtime');
  console.log('Source setup smoke passed: npm install prepares Python without system Python/uv, venv and pip work, npm ci reuses it offline.');
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
