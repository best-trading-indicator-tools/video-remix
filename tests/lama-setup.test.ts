import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLamaSetup } from '../server/lama-setup.js';
// @ts-ignore Shared CLI helper is plain JavaScript.
import { withSetupLock } from '../scripts/setup-lock.mjs';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('concurrent previews and exports share setup and cancelling one preserves the others', async () => {
  const started = gate(), finish = gate();
  let installs = 0, installationSignal: AbortSignal | undefined;
  const setup = createLamaSetup(async (signal, report) => {
    installs++; installationSignal = signal; report('Downloading model'); started.resolve(); await finish.promise;
  });
  const first = new AbortController(), second = new AbortController();
  const phases: string[] = [];
  const one = setup.ensure(first.signal);
  const two = setup.ensure(second.signal, phase => phases.push(phase));
  await started.promise;
  first.abort();
  await assert.rejects(one, { name: 'AbortError' });
  assert.equal(installationSignal!.aborted, false);
  assert.equal(setup.status().phase, 'Downloading model');
  finish.resolve(); await two;
  assert.equal(installs, 1);
  assert.ok(phases.includes('Downloading model'));
  assert.deepEqual(setup.status(), { busy: false, phase: '' });
  await setup.ensure(new AbortController().signal);
  assert.equal(installs, 1, 'A healthy installation is reused');
});

test('failed and cancelled setup can retry, and a retry waits for installer cleanup', async () => {
  const started = gate(), cleanup = gate();
  let installs = 0;
  const setup = createLamaSetup(async signal => {
    installs++;
    if (installs === 1) {
      started.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleanup.promise;
      signal.throwIfAborted();
    } else if (installs === 2) throw new Error('Download unavailable');
  });
  const controller = new AbortController();
  const cancelled = setup.ensure(controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const retry = setup.ensure(new AbortController().signal);
  assert.equal(installs, 1);
  cleanup.resolve();
  await assert.rejects(retry, /Download unavailable/);
  await setup.ensure(new AbortController().signal);
  assert.equal(installs, 3);
  setup.invalidate(); await setup.ensure(new AbortController().signal);
  assert.equal(installs, 4, 'Removed installation is checked again');
});

test('pre-cancelled requests do not start setup and shutdown stops the installer', async () => {
  const started = gate();
  let installs = 0;
  const setup = createLamaSetup(async signal => {
    installs++; started.resolve();
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await assert.rejects(setup.ensure(AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(installs, 0);
  const pending = setup.ensure(new AbortController().signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started.promise; await setup.stop(); await rejected;
  assert.equal(setup.status().busy, false);
});

test('CLI and desktop installers serialize writes and recover a dead installer lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'remix-lama-lock-'));
  const lock = path.join(root, 'lock'), started = gate(), finish = gate(), waiting = gate();
  let active = 0;
  try {
    const first = withSetupLock(lock, async () => {
      active++; started.resolve(); await finish.promise; active--;
    });
    await started.promise;
    const second = withSetupLock(lock, async () => {
      assert.equal(active, 0); await writeFile(path.join(root, 'ready'), 'yes');
    }, () => waiting.resolve());
    await waiting.promise; finish.resolve(); await Promise.all([first, second]);
    assert.equal(await readFile(path.join(root, 'ready'), 'utf8'), 'yes');
    await mkdir(lock); await writeFile(path.join(lock, 'owner'), '2147483647');
    await withSetupLock(lock, async () => { assert.equal(await readFile(path.join(lock, 'owner'), 'utf8'), String(process.pid)); });
    await assert.rejects(withSetupLock(lock, async () => { throw new Error('Network failed'); }), /Network failed/);
    await withSetupLock(lock, async () => {});
  } finally { finish.resolve(); await rm(root, { recursive: true, force: true }); }
});
