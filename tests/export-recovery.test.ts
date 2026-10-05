import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoredJob, StoredSource } from '../server/store.js';
import { failWorkspaceWrites } from './helpers/workspace.js';

test('legacy exports can be reviewed and explicitly deleted without a history dependency or a silent cancel', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remix-export-recovery-'));
  process.env.DATA_DIR = directory;
  const { initStore, closeStore, state, saveStore, publicJob, historyRecords, savePublishing, publishingRecords } = await import('../server/store.js');
  const { createApp } = await import('../server/app.js');
  const { paths } = await import('../server/config.js');
  const { historyEntry } = await import('../server/history.js');
  const { publishingJobs } = await import('../server/publishing-lock.js');
  const { DEFAULT_SETTINGS } = await import('../shared/types.js');
  await initStore();
  const now = new Date().toISOString();
  let job: StoredJob = { id: 'legacy', batchId: 'batch', sourceId: 'original', sourceName: 'Original', variant: 1,
    status: 'completed', progress: 100, settings: { ...DEFAULT_SETTINGS }, createdAt: now, keptAt: now,
    outputPath: path.join(paths.outputs, 'legacy.mp4'), captionPath: path.join(paths.outputs, 'legacy.srt') };
  await writeFile(job.outputPath, 'retained export'); await writeFile(job.captionPath!, 'captions');
  state.jobs.push(job); await saveStore();
  const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, method = 'GET', body?: unknown) => fetch(base + url, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  try {
    assert.equal(publicJob(job).downloadUrl, '/api/jobs/legacy/download');
    assert.equal(publicJob(job).captionUrl, '/api/jobs/legacy/captions');
    assert.equal((await call('/api/jobs/legacy/cancel', 'POST')).status, 409);
    assert.equal((await call('/api/jobs/legacy/review')).status, 200);
    assert.equal((await call('/api/jobs/missing/review', 'PATCH', { verdict: 'rejected' })).status, 404);
    const reviewed = await call('/api/jobs/legacy/review', 'PATCH', { verdict: 'accepted-unchanged', notes: 'Keep this note' });
    assert.equal(reviewed.status, 200); assert.equal(publicJob(job).review?.verdict, 'accepted-unchanged');
    assert.deepEqual(historyRecords(), [], 'Do not invent a source fingerprint or history entry');
    const zip = await call('/api/exports/accepted.zip?ids=legacy');
    assert.equal(zip.status, 200); await zip.arrayBuffer();
    closeStore(); await initStore(); job = state.jobs[0];
    assert.equal(publicJob(job).review?.verdict, 'accepted-unchanged');
    assert.equal((await (await call('/api/jobs/legacy/review')).json()).review.notes, 'Keep this note');
    await failWorkspaceWrites(directory, true);
    assert.equal((await call('/api/jobs/legacy/review', 'PATCH', { verdict: 'rejected' })).status, 500);
    assert.equal(publicJob(job).review?.verdict, 'accepted-unchanged');
    await failWorkspaceWrites(directory, false);
    await call('/api/jobs/legacy/review', 'PATCH', { verdict: null });
    assert.equal(publicJob(job).review?.verdict, undefined); assert.equal(publicJob(job).review?.notes, 'Keep this note');
    await call('/api/jobs/legacy/review', 'PATCH', { verdict: 'needs-edit' });

    const source: StoredSource = { id: 'original', name: 'Original', fingerprint: 'a'.repeat(64), createdAt: now,
      filePath: path.join(paths.uploads, 'original.mp4'), thumbnailPath: path.join(paths.thumbnails, 'original.jpg'),
      thumbnailUrl: '', duration: 10, width: 160, height: 90, fps: 24, hasAudio: false, size: 14 };
    await writeFile(source.filePath, 'original video'); state.sources.push(source);
    const entry = historyEntry(source, job)!;
    assert.equal(entry.measurements?.review?.verdict, 'needs-edit', 'Later history recovery retains the saved decision');
    entry.thumbnailUrl = '/api/history/legacy/thumbnail';
    await saveStore([entry]);
    job.editorDraft = { revision: 1, content: '{}', savedAt: now, token: 'saved-draft' };
    savePublishing('publication', 'scheduled', { id: 'scheduled', jobId: job.id, state: 'scheduled' });
    const work = path.join(paths.work, job.id), plans = path.join(paths.plans, job.id);
    await mkdir(work); await mkdir(plans); await writeFile(path.join(plans, 'edit.json'), '{}'); await saveStore();
    assert.equal((await call('/api/jobs/legacy', 'DELETE')).status, 400);
    assert.equal((await call('/api/jobs/legacy', 'DELETE', { confirm: false })).status, 400);
    job.status = 'queued';
    assert.equal((await call('/api/jobs/legacy', 'DELETE', { confirm: true })).status, 409);
    job.status = 'completed'; publishingJobs.add(job.id);
    assert.equal((await call('/api/jobs/legacy', 'DELETE', { confirm: true })).status, 409);
    publishingJobs.delete(job.id);
    await failWorkspaceWrites(directory, true);
    assert.equal((await call('/api/jobs/legacy', 'DELETE', { confirm: true })).status, 500);
    assert.equal(state.jobs[0], job); await access(job.outputPath);
    await failWorkspaceWrites(directory, false);
    const deleted = await call('/api/jobs/legacy', 'DELETE', { confirm: true });
    assert.equal(deleted.status, 200); assert.equal((await deleted.json()).removedId, job.id);
    for (const file of [job.outputPath, job.captionPath!, work, plans]) await assert.rejects(access(file), { code: 'ENOENT' });
    await access(source.filePath);
    assert.equal(historyRecords()[0]?.measurements?.review?.verdict, 'needs-edit');
    assert.equal(publishingRecords('publication').length, 1);
    closeStore(); await initStore(); assert.equal(state.jobs.length, 0);
    assert.equal(historyRecords().length, 1); await access(source.filePath);
    assert.equal((await call('/api/jobs/legacy', 'DELETE', { confirm: true })).status, 404);
  } finally {
    publishingJobs.clear();
    await new Promise<void>(resolve => server.close(() => resolve())); closeStore();
    await rm(directory, { recursive: true, force: true });
  }
});
