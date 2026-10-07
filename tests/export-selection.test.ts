import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { exportIdsSchema, MAX_EXPORT_SELECTION, retainExportSelection, selectableExports } from '../shared/export-selection.js';
import { DEFAULT_SETTINGS, type RenderJob } from '../shared/types.js';
import { EMPTY_FILTERS, matchesExport } from '../shared/library.js';
import type { StoredJob } from '../server/store.js';
import { failWorkspaceWrites } from './helpers/workspace.js';

function card(id: string, patch: Partial<RenderJob> = {}): RenderJob {
  return { id, sourceId: 'source', sourceName: 'Original', batchId: 'batch', variant: 1,
    status: 'completed', progress: 100, settings: { ...DEFAULT_SETTINGS }, createdAt: '2026-10-07T10:00:00Z', ...patch };
}

test('selection follows visible revisions and filters, excludes running exports and cannot reappear later', () => {
  const first = card('first'), latest = card('latest', { parentJobId: 'first', createdAt: '2026-10-07T11:00:00Z' });
  const other = card('other', { batchId: 'other', exportName: 'Other clip' });
  const queued = card('queued', { status: 'queued' }), processing = card('processing', { status: 'processing' });
  const failed = card('failed', { status: 'failed' });
  const batches = [[first, latest, queued, processing, failed], [other]];
  assert.deepEqual(selectableExports(batches, []).map(job => job.id), ['latest', 'failed', 'other']);
  assert.deepEqual(selectableExports(batches, ['latest']).map(job => job.id), ['latest', 'first', 'failed', 'other']);
  let ids = ['first', 'latest', 'other', 'queued'];
  ids = retainExportSelection(ids, selectableExports(batches, []));
  assert.deepEqual(ids, ['latest', 'other']);
  assert.deepEqual(retainExportSelection(ids, selectableExports(batches, ['latest'])), ['latest', 'other']);
  const filtered = batches.map(batch => batch.filter(job => matchesExport(job, { ...EMPTY_FILTERS, search: 'Other clip' })));
  ids = retainExportSelection(ids, selectableExports(filtered, []));
  assert.deepEqual(ids, ['other']);
  assert.deepEqual(retainExportSelection(ids, selectableExports(batches, [])), ['other']);
  assert.deepEqual(retainExportSelection(ids, []), []);
  assert.deepEqual(retainExportSelection(['latest', 'latest'], [latest]), ['latest']);
  const many = Array.from({ length: 305 }, (_, index) => card(String(index)));
  assert.equal(retainExportSelection(many.map(job => job.id), many).length, MAX_EXPORT_SELECTION);
});

test('bulk operations validate exact IDs, keep/download across collections, and delete only confirmed exports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remix-export-selection-'));
  process.env.DATA_DIR = directory;
  const { initStore, closeStore, state, saveStore, historyRecords, savePublishing, publishingRecords } = await import('../server/store.js');
  const { createApp } = await import('../server/app.js');
  const { paths } = await import('../server/config.js');
  const { publishingJobs } = await import('../server/publishing-lock.js');
  const { historyEntry } = await import('../server/history.js');
  await initStore();
  const jobs: StoredJob[] = ['one', 'two', 'untouched'].map((id, index) => ({ ...card(id, { batchId: `batch-${index}`, exportName: 'Same title' }),
    outputPath: path.join(paths.outputs, `${id}.mp4`), captionPath: path.join(paths.outputs, `${id}.srt`) }));
  const source = { id: 'source', name: 'Original', fingerprint: 'a'.repeat(64), createdAt: jobs[0].createdAt,
    filePath: path.join(paths.uploads, 'source.mp4'), thumbnailPath: path.join(paths.thumbnails, 'source.jpg'),
    thumbnailUrl: '', duration: 10, width: 160, height: 90, fps: 24, hasAudio: false, size: 10 };
  state.sources.push(source); await writeFile(source.filePath, 'original');
  for (const job of jobs) {
    await writeFile(job.outputPath, `video-${job.id}`); await writeFile(job.captionPath!, `captions-${job.id}`);
    await mkdir(path.join(paths.work, job.id)); await mkdir(path.join(paths.plans, job.id));
    await writeFile(path.join(paths.plans, job.id, 'edit.json'), '{}');
  }
  state.jobs.push(...jobs);
  await saveStore(jobs.map(job => historyEntry(source, job)!));
  savePublishing('publication', 'scheduled', { id: 'scheduled', jobId: 'one', state: 'scheduled' });
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, method = 'GET', body?: unknown) => fetch(base + url, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const keep = (ids: string[]) => call('/api/exports/keep', 'PATCH', { ids });
  const remove = (ids: string[], confirm = true) => call('/api/exports/selected', 'DELETE', { ids, confirm });
  const download = (ids: string[]) => call(`/api/exports/selected.zip?ids=${encodeURIComponent(ids.join(','))}`);
  try {
    for (const ids of [[], ['one', 'one'], [''], Array.from({ length: 301 }, (_, i) => String(i))]) {
      assert.equal(exportIdsSchema.safeParse(ids).success, false);
      assert.equal((await keep(ids)).status, 400); assert.equal((await remove(ids)).status, 400); assert.equal((await download(ids)).status, 400);
    }
    assert.equal((await remove(['one', 'two'], false)).status, 400);
    assert.equal((await call('/api/exports/selected', 'DELETE', { ids: ['one'] })).status, 400);
    for (const action of [keep, remove, download]) assert.equal((await action(['one', 'missing'])).status, 409);
    assert.equal(jobs[0].keptAt, undefined); assert.equal(state.jobs.length, 3);
    for (const status of ['queued', 'processing'] as const) {
      jobs[1].status = status;
      for (const action of [keep, remove, download]) assert.equal((await action(['one', 'two'])).status, 409);
    }
    jobs[1].status = 'completed'; publishingJobs.add('two');
    assert.equal((await remove(['one', 'two'])).status, 409);
    publishingJobs.delete('two');
    await failWorkspaceWrites(directory, true);
    assert.equal((await keep(['one', 'two'])).status, 500);
    assert.equal(jobs[0].keptAt, undefined); assert.equal(jobs[1].keptAt, undefined);
    assert.equal((await remove(['one', 'two'])).status, 500);
    assert.deepEqual(state.jobs.map(job => job.id), ['one', 'two', 'untouched']);
    await access(jobs[0].outputPath); await access(jobs[1].outputPath);
    await failWorkspaceWrites(directory, false);

    const kept = await keep(['two', 'one']); assert.equal(kept.status, 200);
    assert.deepEqual((await kept.json()).jobs.map((job: RenderJob) => job.id), ['two', 'one']);
    assert.ok(jobs[0].keptAt); assert.ok(jobs[1].keptAt); assert.equal(jobs[2].keptAt, undefined);
    const keptAt = jobs[0].keptAt; await keep(['one', 'two']); assert.equal(jobs[0].keptAt, keptAt);

    const zip = await download(['two', 'one']); assert.equal(zip.status, 200);
    assert.match(zip.headers.get('content-disposition')!, /selected-exports.zip/);
    const zipPath = path.join(directory, 'selected.zip'); await writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
    const exec = promisify(execFile);
    const listing = (await exec('unzip', ['-Z1', zipPath])).stdout.trim().split('\n');
    assert.deepEqual(listing.sort(), ['01-Same title.mp4', '01-Same title.srt', '02-Same title.mp4', '02-Same title.srt']);
    assert.equal((await exec('unzip', ['-p', zipPath, '01-Same title.mp4'])).stdout, 'video-two');
    assert.equal((await exec('unzip', ['-p', zipPath, '02-Same title.mp4'])).stdout, 'video-one');
    await rm(jobs[1].outputPath);
    assert.equal((await download(['one', 'two'])).status, 404, 'Missing files fail before starting a partial ZIP');
    await writeFile(jobs[1].outputPath, 'video-two');

    jobs[0].editorDraft = { revision: 1, content: '{}', savedAt: jobs[0].createdAt, token: 'draft' };
    await saveStore();
    const deleted = await remove(['one', 'two']); assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { removedIds: ['one', 'two'], cleanupFailedIds: [] });
    assert.deepEqual(state.jobs.map(job => job.id), ['untouched']);
    for (const job of jobs.slice(0, 2)) for (const file of [job.outputPath, job.captionPath!, path.join(paths.work, job.id), path.join(paths.plans, job.id)]) {
      await assert.rejects(access(file), { code: 'ENOENT' });
    }
    await access(jobs[2].outputPath); await access(source.filePath);
    assert.equal(historyRecords().length, 3); assert.equal(publishingRecords('publication').length, 1);
    closeStore(); await initStore();
    assert.deepEqual(state.jobs.map(job => job.id), ['untouched']); assert.equal(historyRecords().length, 3);

    // Terminal failures have no usable download, but can still be cleaned up in bulk.
    const terminal: StoredJob[] = (['failed', 'cancelled', 'skipped'] as const).map(status => ({
      ...card(status, { status }), outputPath: path.join(paths.outputs, `${status}.mp4`),
    }));
    state.jobs.push(...terminal); await saveStore();
    assert.equal((await keep(terminal.map(job => job.id))).status, 409);
    assert.equal((await download(terminal.map(job => job.id))).status, 409);
    assert.equal((await remove(terminal.map(job => job.id))).status, 200);
    assert.deepEqual(state.jobs.map(job => job.id), ['untouched']);
  } finally {
    publishingJobs.clear();
    await new Promise<void>(resolve => server.close(() => resolve())); closeStore();
    await rm(directory, { recursive: true, force: true });
  }
});
