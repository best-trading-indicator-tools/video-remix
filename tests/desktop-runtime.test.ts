import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The desktop shell intentionally uses plain JS, independent of the web bundle.
// @ts-ignore runtime module
import { prepareRuntime, desktopEnvironment, installComponents, run } from '../desktop/runtime.mjs';

test('desktop preparation copies public runtime assets, preserves models, and never copies workspace secrets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remix-desktop-runtime-'));
  const root = path.join(directory, 'app'), runtime = path.join(directory, 'private engine');
  try {
    for (const folder of ['scripts/models', 'dist', 'data']) await mkdir(path.join(root, folder), { recursive: true });
    await writeFile(path.join(root, '.env'), 'PRIVATE_KEY=secret');
    await writeFile(path.join(root, 'data/private.mp4'), 'personal media');
    await writeFile(path.join(root, 'scripts/models/developer.pth'), 'developer model');
    await writeFile(path.join(root, 'scripts/setup.mjs'), 'public script');
    await writeFile(path.join(root, 'dist/index.html'), '<html>public app</html>');
    await writeFile(path.join(root, 'requirements-upscale.txt'), 'torch');
    await mkdir(path.join(runtime, 'scripts/models'), { recursive: true });
    await writeFile(path.join(runtime, 'scripts/models/user.pth'), 'downloaded model');
    await prepareRuntime(root, runtime);
    assert.deepEqual((await readdir(runtime)).sort(), ['dist', 'requirements-upscale.txt', 'scripts']);
    assert.deepEqual(await readdir(path.join(runtime, 'scripts/models')), ['user.pth']);
    assert.equal(await readFile(path.join(runtime, 'scripts/setup.mjs'), 'utf8'), 'public script');
    const env = desktopEnvironment(root, runtime, path.join(directory, 'workspace'), path.join(root, 'tools'));
    assert.equal(env.PORT, '0'); assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed');
    assert.ok(env.PATH.startsWith(path.join(root, 'tools') + path.delimiter));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop installer rejects arbitrary commands and duplicate selections before starting any work', async () => {
  for (const ids of [[], ['../private'], ['upscale', 'upscale'], 'upscale', [42]]) {
    await assert.rejects(installComponents(ids, {}), /valid local tools/);
  }
});

test('desktop process runner captures output and cancels a running task', async () => {
  assert.equal(await run(process.execPath, ['-e', 'console.log("ready")']), 'ready');
  const controller = new AbortController();
  const result = run(process.execPath, ['-e', 'console.log("started");setInterval(()=>{},1000)'], {
    signal: controller.signal, onLine: () => controller.abort(),
  });
  await assert.rejects(result, /cancelled/);
  await assert.rejects(run(process.execPath, [], { signal: controller.signal }), /cancelled/);
});
