import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
// @ts-ignore Plain JS shared by the source installer and desktop setup.
import { managedPython, privatePythonEnvironment, verifyPythonInstaller } from '../scripts/python-runtime.mjs';
import { findPython } from '../scripts/setup-python.mjs';

const exec = promisify(execFile);

test('setup finds project Python before PATH and respects an explicit interpreter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remix private python '));
  const directory = path.join(root, '.remix-python');
  const executable = path.join(directory, 'python', 'cpython', 'python.exe');
  try {
    await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, 'fixture');
    await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ executable: path.relative(directory, executable) }));
    assert.equal(await managedPython(root), executable);
    const calls: string[] = [];
    assert.deepEqual(await findPython(async (command: string) => { calls.push(command); }, { root, pythonBin: undefined }), { command: executable, args: [] });
    assert.deepEqual(calls, [executable]);
    const override = path.join(root, 'my Python', 'python.exe');
    assert.deepEqual(await findPython(async (command: string) => { assert.equal(command, override); }, { root, pythonBin: override }), { command: override, args: [] });
    for (const candidate of ['../other/python', executable, 'python/../../outside']) {
      await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ executable: candidate }));
      assert.equal(await managedPython(root), undefined);
    }
    await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ executable: 'python/missing' }));
    assert.equal(await managedPython(root), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Python setup confines uv to the project and rejects a changed download', () => {
  const root = path.resolve('private runtime');
  const input = { PATH: 'existing path', VIRTUAL_ENV: '/some/venv', PYTHONHOME: '/old/python', PYTHONPATH: '/old/packages' };
  const env = privatePythonEnvironment(root, input);
  assert.equal(env.PATH, input.PATH);
  assert.equal(env.UV_PYTHON_INSTALL_DIR, path.join(root, '.remix-python/python'));
  assert.equal(env.UV_PYTHON_BIN_DIR, path.join(root, '.remix-python/bin'));
  for (const key of ['VIRTUAL_ENV', 'PYTHONHOME', 'PYTHONPATH']) assert.equal(env[key], undefined);
  assert.equal(input.PYTHONHOME, '/old/python');
  const bytes = Buffer.from('verified archive');
  const hash = createHash('sha256').update(bytes).digest('hex');
  verifyPythonInstaller(bytes, hash);
  assert.throws(() => verifyPythonInstaller(Buffer.from('changed archive'), hash), /checksum mismatch/);
});

test('npm hook tolerates unavailable Python, supports opting out, and explicit retries fail clearly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remix-python-hook-'));
  try {
    await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'desktop'));
    for (const name of ['setup-python-runtime.mjs', 'python-runtime.mjs', 'setup-lock.mjs'])
      await cp(path.resolve('scripts', name), path.join(root, 'scripts', name));
    // No asset for this platform: exercise failure without network access.
    await writeFile(path.join(root, 'desktop/assets.json'), JSON.stringify({ uv: {} }));
    const env = { ...process.env, PYTHON_BIN: '', REMIX_RUNTIME_DIR: root, REMIX_SKIP_PYTHON_SETUP: '' };
    const script = path.join(root, 'scripts/setup-python-runtime.mjs');
    const optional = await exec(process.execPath, [script, '--optional'], { env });
    assert.match(optional.stderr, /npm run setup:python/);
    await assert.rejects(exec(process.execPath, [script], { env }), (error: unknown) => {
      assert.equal((error as { code: number }).code, 1); return true;
    });
    await rm(path.join(root, 'desktop/assets.json')); // Docker's npm dependency layer has no model manifests.
    const skipped = await exec(process.execPath, [script, '--optional'], { env: { ...env, REMIX_SKIP_PYTHON_SETUP: '1' } });
    assert.match(skipped.stdout, /skipped/); assert.equal(skipped.stderr, '');
    const invalidOverride = await exec(process.execPath, [script, '--optional'], { env: { ...env, PYTHON_BIN: path.join(root, 'missing Python') } });
    assert.match(invalidOverride.stderr, /ENOENT/);
    assert.doesNotMatch(invalidOverride.stderr, /Automatic Python setup supports/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
