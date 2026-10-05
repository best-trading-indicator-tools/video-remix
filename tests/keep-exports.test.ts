import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoredJob, StoredSource } from '../server/store.js';
import { failWorkspaceWrites } from './helpers/workspace.js';

test('Keep survives expiry, collection clearing and restart; releasing it starts a fresh retention window', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remix-keep-'));
  process.env.DATA_DIR = dir;
  const { initStore, state, saveStore, closeStore } = await import('../server/store.js');
  const { config, paths } = await import('../server/config.js');
  const { createApp } = await import('../server/app.js');
  const { cleanupExpired } = await import('../server/queue.js');
  const { DEFAULT_SETTINGS } = await import('../shared/types.js');
  await initStore();
  const old = new Date(Date.now() - config.retentionMs - 60000).toISOString();
  const sourceFile = path.join(paths.uploads, 'source.mp4');
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=24:d=1', '-c:v', 'libx264', '-threads', '1', sourceFile]);
  const source: StoredSource = { id: 'source', name: 'Test', filePath: sourceFile,
    thumbnailPath: path.join(paths.thumbnails, 'source.jpg'), thumbnailUrl: '', duration: 1,
    width: 160, height: 90, fps: 24, hasAudio: false, size: 1000, createdAt: old };
  const output = path.join(paths.outputs, 'kept.mp4');
  const captions = path.join(paths.outputs, 'kept.srt');
  const attachment = path.join(paths.attachments, 'speech.srt');
  const planDir = path.join(paths.plans, 'kept');
  await mkdir(planDir, { recursive: true });
  await Promise.all([copyFile(sourceFile, output), copyFile(sourceFile, path.join(planDir, 'shot.mp4')),
    writeFile(captions, '1\n00:00:00,000 --> 00:00:01,000\nHello\n'), writeFile(attachment, 'speech'), writeFile(source.thumbnailPath, 'thumbnail')]);
  const job: StoredJob = { id: 'kept', sourceId: source.id, sourceName: source.name, variant: 1, batchId: 'batch',
    status: 'completed', progress: 100, createdAt: old, finishedAt: old,
    settings: { ...DEFAULT_SETTINGS, subtitleId: 'subtitle' }, outputPath: output, captionPath: captions,
    editPlan: { version: 1, revision: 1, sourceId: source.id, sourceDuration: 1, outputDuration: 1, createdAt: old,
      settings: { ...DEFAULT_SETTINGS }, cuts: [{ start: 0, end: 1 }], captions: [], visuals: [], narration: false,
      media: [{ id: 'shot', name: 'Shot', kind: 'broll', duration: 1 }] }, planFiles: { shot: 'shot.mp4' } };
  const expired: StoredJob = { ...job, id: 'expired', outputPath: path.join(paths.outputs, 'expired.mp4'), captionPath: undefined, editPlan: undefined, planFiles: undefined };
  await copyFile(sourceFile, expired.outputPath);
  state.sources.push(source); state.jobs.push(job, expired);
  state.attachments.push({ id: 'subtitle', name: 'Speech', kind: 'subtitle', filePath: attachment, createdAt: old });
  await saveStore();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (url: string, method = 'GET', body?: unknown) => fetch(base + url, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  try {
    assert.equal((await request('/api/jobs/missing/keep', 'PATCH', { keep: true })).status, 404);
    assert.equal((await request('/api/jobs/kept/keep', 'PATCH', { keep: 'true' })).status, 400);
    expired.status = 'failed';
    assert.equal((await request('/api/jobs/expired/keep', 'PATCH', { keep: true })).status, 409);
    const response = await request('/api/jobs/kept/keep', 'PATCH', { keep: true });
    assert.equal(response.status, 200); assert.ok((await response.json()).keptAt);
    const keptAt = job.keptAt;
    await request('/api/jobs/kept/keep', 'PATCH', { keep: true });
    assert.equal(job.keptAt, keptAt, 'Repeated Keep is idempotent');
    await failWorkspaceWrites(dir, true);
    assert.equal((await request('/api/jobs/kept/keep', 'PATCH', { keep: false })).status, 500);
    assert.equal(job.keptAt, keptAt, 'A failed save must not remove the protection in memory');
    await failWorkspaceWrites(dir, false);
    await cleanupExpired();
    assert.deepEqual(state.jobs.map(item => item.id), ['kept']);
    for (const file of [output, captions, sourceFile, attachment, path.join(planDir, 'shot.mp4')]) await access(file);
    await assert.rejects(access(expired.outputPath), { code: 'ENOENT' });
    assert.equal((await request('/api/jobs/kept/plan')).status, 200);
    assert.equal((await request('/api/jobs/kept/download')).status, 200);
    assert.equal((await request('/api/sources/source', 'DELETE')).status, 409);

    // A mixed collection clears only unkept jobs and reports exactly what disappeared.
    const unkept = { ...expired, id: 'unkept', outputPath: path.join(paths.outputs, 'unkept.mp4') };
    await copyFile(sourceFile, unkept.outputPath); state.jobs.push(unkept); await saveStore();
    const cleared = await request('/api/batches/batch', 'DELETE');
    assert.equal(cleared.status, 200); assert.deepEqual((await cleared.json()).removedIds, ['unkept']);
    assert.deepEqual(state.jobs.map(item => item.id), ['kept']);
    await access(output); await assert.rejects(access(unkept.outputPath), { code: 'ENOENT' });
    const onlyKept = await request('/api/batches/batch', 'DELETE');
    assert.deepEqual((await onlyKept.json()).removedIds, []);

    closeStore(); await initStore(); await cleanupExpired();
    assert.equal(state.jobs[0]?.keptAt, keptAt, 'Keep survives a database restart');
    assert.equal((await request('/api/jobs/kept/plan')).status, 200);
    const released = await request('/api/jobs/kept/keep', 'PATCH', { keep: false });
    assert.equal(released.status, 200);
    const result = await released.json(); assert.equal(result.keptAt, undefined);
    assert.ok(Date.now() - Date.parse(result.retentionResetAt) < 5000);
    await request('/api/jobs/kept/keep', 'PATCH', { keep: false });
    assert.equal(state.jobs[0].retentionResetAt, result.retentionResetAt, 'Repeated release does not extend retention');
    await cleanupExpired(); await access(output);
    state.jobs[0].retentionResetAt = old;
    await cleanupExpired();
    assert.equal(state.jobs.length, 0); assert.equal(state.sources.length, 0); assert.equal(state.attachments.length, 0);
    for (const file of [output, captions, sourceFile, attachment, planDir]) await assert.rejects(access(file), { code: 'ENOENT' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeStore(); await rm(dir, { recursive: true, force: true });
  }
});
