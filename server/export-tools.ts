import type { Express } from 'express';
import { z } from 'zod';
import { state, historyRecords, saveStore, publicJob } from './store.js';
import { historyThumbnailExists, historyThumbnailPath, retainHistoryThumbnail } from './history-thumbnails.js';
import { publicEditPlan, planMediaPath } from './plan-storage.js';
import { applyEditPlanChanges, editPlanChangesSchema } from './edit-plan.js';
import { audioWaveform } from './waveform.js';

const titleSchema = z.object({ title: z.string().trim().min(1).max(90).regex(/^[^\u0000-\u001f\u007f]+$/u) }).strict();
export const quickReviewSchema = z.object({ verdict: z.enum(['accepted-unchanged', 'accepted-after-correction', 'rejected']).optional(), notes: z.string().trim().max(500).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u).optional() }).strict();
export function installExportTools(app: Express) {
  app.patch('/api/jobs/:id/keep', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id);
    const parsed = z.object({ keep: z.boolean() }).strict().safeParse(req.body);
    if (!job) { res.status(404).json({ error: 'Export not found or already expired.' }); return; }
    if (!parsed.success) { res.status(400).json({ error: 'Choose whether to keep this export.' }); return; }
    if (job.status !== 'completed') { res.status(409).json({ error: 'Wait for this export to finish before keeping it.' }); return; }
    const previous = { keptAt: job.keptAt, retentionResetAt: job.retentionResetAt };
    if (parsed.data.keep) job.keptAt ??= new Date().toISOString();
    else if (job.keptAt) {
      delete job.keptAt;
      job.retentionResetAt = new Date().toISOString();
    }
    try { await saveStore(); }
    catch (error) { Object.assign(job, previous); throw error; }
    res.json(publicJob(job));
  });
  app.patch('/api/jobs/:id/title', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id), parsed = titleSchema.safeParse(req.body);
    if (!job) { res.status(404).json({ error: 'Export not found.' }); return; }
    if (!parsed.success) { res.status(400).json({ error: 'Use a title between 1 and 90 characters.' }); return; }
    job.exportName = parsed.data.title;
    const entries = historyRecords({ jobId: job.id });
    for (const entry of entries) entry.title = job.exportName;
    await saveStore(entries); res.json(publicJob(job));
  });
  app.get('/api/jobs/:id/review', (req, res) => {
    const entry = historyRecords({ jobId: String(req.params.id) })[0];
    if (!entry) { res.status(404).json({ error: 'This export has no saved history record.' }); return; }
    res.json({ review: entry.measurements?.review ?? {}, corrected: Boolean(entry.parentJobId) });
  });
  app.patch('/api/jobs/:id/review', async (req, res) => {
    const entry = historyRecords({ jobId: String(req.params.id) })[0], parsed = quickReviewSchema.safeParse(req.body);
    if (!entry) { res.status(404).json({ error: 'This export has no saved history record.' }); return; }
    if (!parsed.success) { res.status(400).json({ error: 'Choose a review decision and keep notes under 500 characters.' }); return; }
    entry.measurements = { ...entry.measurements, review: { ...entry.measurements?.review, ...parsed.data } };
    await saveStore([entry]); res.json(entry.measurements.review);
  });
  app.get('/api/jobs/:id/thumbnail', async (req, res, next) => {
    const job = state.jobs.find(job => job.id === req.params.id);
    if (!job) { res.status(404).end(); return; }
    if (!await historyThumbnailExists(job.id) && job.status === 'completed')
      await retainHistoryThumbnail({ id: job.id, outputDuration: job.summary?.outputDuration ?? 1 }, job.outputPath);
    const file = await historyThumbnailExists(job.id) ? historyThumbnailPath(job.id) : state.sources.find(source => source.id === job.sourceId)?.thumbnailPath;
    if (!file) { res.status(404).end(); return; }
    res.type('image/jpeg').setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, error => { if (error) next(error); });
  });
  app.post('/api/jobs/:id/plan/preview', (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id), parsed = editPlanChangesSchema.safeParse(req.body);
    if (!job?.editPlan) { res.status(404).json({ error: 'Saved edit not found.' }); return; }
    if (!parsed.success) { res.status(400).json({ error: 'Check the timeline intervals.' }); return; }
    try { const editPlan = applyEditPlanChanges(job.editPlan, parsed.data, job.sourceTranscript); editPlan.revision = job.editPlan.revision; res.json(publicEditPlan({ ...job, editPlan })); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.get('/api/jobs/:id/waveform', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id), plan = job?.editPlan;
    if (!job || !plan) { res.status(404).json({ error: 'Saved edit not found.' }); return; }
    const source = state.sources.find(source => source.id === job.sourceId);
    const file = plan.audioMediaId ? planMediaPath(job, plan.audioMediaId) : source?.filePath;
    if (!file) { res.json({ peaks: [], duration: 0, clock: 'source' }); return; }
    const duration = plan.audioMediaId ? plan.media.find(media => media.id === plan.audioMediaId)!.duration : plan.sourceDuration;
    res.json({ ...await audioWaveform(file, duration), clock: plan.audioMediaId ? 'output' : 'source' });
  });
}
