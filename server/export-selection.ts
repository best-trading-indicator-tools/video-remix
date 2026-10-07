import type { Express, Response } from 'express';
import { z } from 'zod';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { exportIdsSchema } from '../shared/export-selection.js';
import { exportTitle } from '../shared/export-presentation.js';
import { paths } from './config.js';
import { isActive, isRunning } from './queue.js';
import { publishingJobs } from './publishing-lock.js';
import { publicJob, saveStore, state, type StoredJob } from './store.js';

// Resolve every ID before changing anything. A stale selection must never silently
// become an operation on a different subset (or on the whole collection).
function selectedJobs(ids: string[], res: Response): StoredJob[] | undefined {
  const byId = new Map(state.jobs.map(job => [job.id, job]));
  const jobs = ids.map(id => byId.get(id));
  if (jobs.some(job => !job)) {
    res.status(409).json({ error: 'Some selected exports are no longer available. Refresh your selection and try again.' });
    return;
  }
  return jobs as StoredJob[];
}

export function installExportSelectionRoutes(app: Express) {
  app.patch('/api/exports/keep', async (req, res) => {
    const parsed = z.object({ ids: exportIdsSchema }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose between 1 and 300 different exports to keep.' }); return; }
    const jobs = selectedJobs(parsed.data.ids, res);
    if (!jobs) return;
    if (jobs.some(job => job.status !== 'completed')) {
      res.status(409).json({ error: 'Only finished exports can be kept. Update your selection and try again.' }); return;
    }
    const previous = jobs.map(job => job.keptAt), now = new Date().toISOString();
    for (const job of jobs) job.keptAt ??= now;
    try { await saveStore(); }
    catch (error) { jobs.forEach((job, index) => job.keptAt = previous[index]); throw error; }
    res.json({ jobs: jobs.map(publicJob) });
  });

  app.delete('/api/exports/selected', async (req, res) => {
    const parsed = z.object({ ids: exportIdsSchema, confirm: z.literal(true) }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Confirm deleting 1 to 300 selected exports and their editing files, including any Keep or saved draft.' }); return; }
    const jobs = selectedJobs(parsed.data.ids, res);
    if (!jobs) return;
    if (jobs.some(job => isActive(job) || isRunning(job.id) || publishingJobs.has(job.id))) {
      res.status(409).json({ error: 'Wait for rendering and uploads to finish before deleting these exports. Nothing was deleted.' }); return;
    }
    const ids = new Set(parsed.data.ids), previous = state.jobs;
    state.jobs = state.jobs.filter(job => !ids.has(job.id));
    try { await saveStore(); }
    catch (error) { state.jobs = previous; throw error; }
    const cleanup = await Promise.allSettled(jobs.map(async job => {
      const files = await Promise.allSettled([
        rm(job.outputPath, { force: true }),
        rm(path.join(paths.work, job.id), { recursive: true, force: true }),
        rm(path.join(paths.plans, job.id), { recursive: true, force: true }),
        ...(job.captionPath ? [rm(job.captionPath, { force: true })] : []),
      ]);
      const failure = files.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }));
    const cleanupFailedIds = jobs.filter((_, index) => cleanup[index].status === 'rejected').map(job => job.id);
    res.json({ removedIds: parsed.data.ids, cleanupFailedIds });
  });

  app.get('/api/exports/selected.zip', async (req, res) => {
    const parsed = exportIdsSchema.safeParse(typeof req.query.ids === 'string' ? req.query.ids.split(',') : []);
    if (!parsed.success) { res.status(400).json({ error: 'Choose between 1 and 300 different exports to download.' }); return; }
    const jobs = selectedJobs(parsed.data, res);
    if (!jobs) return;
    if (jobs.some(job => job.status !== 'completed')) {
      res.status(409).json({ error: 'Only finished exports can be downloaded. Update your selection and try again.' }); return;
    }
    // Check the whole selection before sending a ZIP header, including captions.
    for (const job of jobs) {
      await stat(job.outputPath);
      if (job.captionPath) await stat(job.captionPath);
    }
    const archive = new ZipArchive({ zlib: { level: 0 } });
    archive.on('error', error => res.destroy(error));
    archive.on('warning', error => res.destroy(error));
    res.attachment('selected-exports.zip');
    res.on('close', () => archive.abort());
    archive.pipe(res);
    jobs.forEach((job, index) => {
      const title = exportTitle(job).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 90) || 'export';
      const name = `${String(index + 1).padStart(2, '0')}-${title}`;
      archive.file(job.outputPath, { name: `${name}.mp4` });
      if (job.captionPath) archive.file(job.captionPath, { name: `${name}.srt` });
    });
    await archive.finalize();
  });
}
