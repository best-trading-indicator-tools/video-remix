import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { geometry, probeMedia, renderVideo } from '../server/engine.js';
import { autoOptionsSchema, settingsSchema } from '../server/schema.js';
import { manualPreviewSettings } from '../server/manual-preview.js';
import { captureFinishingPreset } from '../shared/finishing-presets.js';
import { runLocal } from '../server/auto-process.js';
import { upscaleCapabilities } from '../server/upscale.js';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

const source = { width: 640, height: 360, duration: 10, fps: 24, hasAudio: true };
async function modelReady() {
  const capability = await upscaleCapabilities();
  if (process.env.REQUIRE_UPSCALE_TESTS === 'true') assert.equal(capability.ready, true, capability.error);
  return capability.ready;
}
test('AI targets preserve orientation, never downscale native pictures and override ordinary resolution', () => {
  assert.deepEqual(geometry(source, { ...DEFAULT_SETTINGS, upscale: '2160', resolution: '720' }), { width: 3840, height: 2160 });
  assert.deepEqual(geometry({ ...source, width: 360, height: 640 }, { ...DEFAULT_SETTINGS, upscale: '1080' }), { width: 1080, height: 1920 });
  assert.deepEqual(geometry(source, { ...DEFAULT_SETTINGS, aspect: '1:1', upscale: '1440' }), { width: 1440, height: 1440 });
  assert.deepEqual(geometry({ ...source, width: 3840, height: 2160 }, { ...DEFAULT_SETTINGS, upscale: '1080' }), { width: 3840, height: 2160 });
  assert.deepEqual(geometry(source, { ...DEFAULT_SETTINGS, upscale: 'off' }), { width: 640, height: 360 });
  assert.deepEqual(geometry(source, DEFAULT_SETTINGS), geometry(source, { ...DEFAULT_SETTINGS, upscale: 'off' }));
});

test('upscaling persists in both modes and presets, validates targets and previews the real input detail', () => {
  for (const upscale of ['off', '1080', '1440', '2160'] as const) {
    assert.equal(settingsSchema.parse({ ...DEFAULT_SETTINGS, upscale }).upscale, upscale);
    assert.equal(autoOptionsSchema.parse({ upscale }).upscale, upscale);
    assert.equal(captureFinishingPreset('manual', 'AI', { ...DEFAULT_SETTINGS, upscale }, 'test').settings.upscale, upscale);
    assert.equal(captureFinishingPreset('auto', 'AI', { aspect: 'original', upscale }, 'test').settings.upscale, upscale);
  }
  assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, upscale: '8K' }).success, false);
  assert.equal(autoOptionsSchema.safeParse({ upscale: { command: 'anything' } }).success, false);
  const preview = manualPreviewSettings({ ...DEFAULT_SETTINGS, upscale: '2160' }, source);
  assert.deepEqual(preview.source, source, 'An AI quality preview must not discard source detail before inference');
  assert.equal(preview.duration, 5);
});

test('Real-ESRGAN renders selected cuts with audio and text, cleans temporary files and reports monotonic progress', { timeout: 120_000 }, async t => {
  if (!await modelReady()) return t.skip('Install the optional local model with npm run setup:upscale');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remix-upscale-'));
  try {
    const input = path.join(directory, "source ' with spaces.mp4"), output = path.join(directory, 'output.mp4');
    const workDir = path.join(directory, 'work');
    await runLocal('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', input]);
    const source = await probeMedia(input);
    const progress: number[] = [];
    await renderVideo({ input, output, source, workDir, signal: new AbortController().signal,
      settings: { ...DEFAULT_SETTINGS, upscale: '1080', segments: [{ start: .5, end: 1 }, { start: 0, end: .25 }], hookText: 'AI sample' },
      onProgress: value => progress.push(value) });
    const result = await probeMedia(output);
    assert.deepEqual([result.width, result.height, result.hasAudio, result.fps], [1920, 1080, true, 12]);
    assert.ok(Math.abs(result.duration - .75) < .1, `Unexpected duration: ${result.duration}`);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every((value, index) => !index || value >= progress[index - 1]!));
    assert.deepEqual(await readdir(workDir), []);
    const colors = await runLocal('ffmpeg', ['-v', 'error', '-i', output, '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
    const luma = Number(colors.stdout.match(/lavfi.signalstats.YAVG=([\d.]+)/)?.[1]);
    assert.ok(luma > 30 && luma < 220, 'The reconstructed picture must not be blank');

    const controller = new AbortController();
    await assert.rejects(renderVideo({ input, output: path.join(directory, 'cancelled.mp4'), source, workDir,
      signal: controller.signal, settings: { ...DEFAULT_SETTINGS, upscale: '2160' },
      onProgress: value => { if (value > 0) controller.abort(); } }), /Cancelled|aborted/i);
    assert.deepEqual(await readdir(workDir), [], 'Cancelling inference removes its plan and lossless video');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a real Auto batch upscales both videos to 4K without cloud requests or losing per-video settings', { timeout: 120_000 }, async t => {
  if (!await modelReady()) return t.skip('Install the optional local model with npm run setup:upscale');
  const { initStore, state, saveStore } = await import('../server/store.js');
  const { paths } = await import('../server/config.js');
  const { createApp } = await import('../server/app.js');
  const { stopQueue } = await import('../server/queue.js');
  await initStore();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    assert.ok(String(input).startsWith(base + '/'), 'Upscaling must not call a cloud provider');
    return fetchOriginal(input, init);
  });
  try {
    for (const color of ['red', 'blue']) {
      const id = randomUUID(), filePath = path.join(paths.uploads, `${id}.mp4`);
      await runLocal('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=160x90:r=30:d=0.2`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', filePath]);
      state.sources.push({ id, name: `${color}.mp4`, filePath, size: (await stat(filePath)).size,
        ...await probeMedia(filePath), createdAt: new Date().toISOString() });
    }
    await saveStore();
    const response = await fetch(`${base}/api/auto/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: state.sources.map((item, index) => ({ sourceId: item.id, variants: 1,
        options: { aspect: index ? '1:1' : 'original', durationMode: 'full', upscale: '2160', captions: 'keep', audio: 'off',
          narration: false, editorialMode: 'off', finishedReview: false, visualSources: [] } })) }) });
    assert.equal(response.status, 201, await response.clone().text());
    const deadline = Date.now() + 100_000;
    while (state.jobs.some(job => ['queued', 'processing'].includes(job.status)) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(state.jobs.length, 2);
    for (const job of state.jobs) {
      assert.equal(job.status, 'completed', job.error ?? job.phase);
      assert.equal(job.settings.upscale, '2160');
      const result = await probeMedia(job.outputPath);
      assert.equal(result.height, 2160);
      assert.equal(result.width, job.settings.aspect === '1:1' ? 2160 : 3840);
      assert.equal(result.hasAudio, true);
      assert.ok(Math.abs(result.duration - .2) < .1);
      assert.equal(job.editPlan?.settings.upscale, '2160');
    }
  } finally {
    await stopQueue();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
