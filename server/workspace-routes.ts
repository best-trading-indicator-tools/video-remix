import type { Express } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { ZipArchive } from 'archiver';
import { historyProjects, historyRecords, publicJob, publicSource, saveStore, state } from './store.js';
import { assertLinkedSourceUnchanged } from './media-imports.js';
import { publishingJobs } from './publishing-lock.js';
import { reviewStatus } from '../shared/library.js';

const projectSchema = z.object({ project: z.string().trim().max(60).regex(/^[^\u0000-\u001f\u007f]*$/u) }).strict();
const draftSchema = z.object({ revision: z.number().int().nonnegative(), content: z.string().max(400_000), token: z.string().nullable() }).strict();
export function installWorkspaceRoutes(app: Express) {
  app.get('/api/library/projects', (_req, res) => {
    const projects = new Set([...state.sources.map(source => source.project), ...state.jobs.map(job => job.project)]);
    for (const project of historyProjects()) projects.add(project);
    res.json({ projects: [...projects].filter(Boolean).sort() });
  });
  app.patch('/api/history/:id/project', async (req, res) => {
    const entry = historyRecords({ id: String(req.params.id) })[0], parsed = projectSchema.safeParse(req.body);
    if (!entry || !parsed.success) { res.status(400).json({ error: 'Choose a saved export and a project name up to 60 characters.' }); return; }
    const job = state.jobs.find(job => job.id === entry.jobId), previous = job?.project;
    entry.project = parsed.data.project; if (job) job.project = parsed.data.project;
    try { await saveStore([entry]); } catch (error) { if (job) job.project = previous; throw error; }
    res.json(entry);
  });
  app.get('/api/jobs/:id/draft', (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id);
    if (!job?.editPlan) { res.status(404).json({ error: 'Saved edit not found.' }); return; }
    res.json({ draft: job.editorDraft ?? null });
  });
  app.put('/api/jobs/:id/draft', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id), parsed = draftSchema.safeParse(req.body);
    if (!job?.editPlan) { res.status(404).json({ error: 'This export expired before the draft could be saved. Keep the browser backup and reconnect its source.' }); return; }
    if (!parsed.success) { res.status(400).json({ error: 'This draft is too large or invalid. It remains in this browser.' }); return; }
    if (parsed.data.revision !== job.editPlan.revision || parsed.data.token !== (job.editorDraft?.token ?? null)) {
      res.status(409).json({ error: 'A newer draft was saved in another window. Close and reopen this editor before making more changes.' }); return;
    }
    try { const value = JSON.parse(parsed.data.content); if (!value || typeof value !== 'object' || !value.draft || !Array.isArray(value.draft.cuts) || value.draft.sourceId !== job.sourceId) throw new Error(); }
    catch { res.status(400).json({ error: 'Draft content is invalid.' }); return; }
    const previous = job.editorDraft;
    job.editorDraft = { revision: parsed.data.revision, content: parsed.data.content, token: randomUUID(), savedAt: new Date().toISOString() };
    try { await saveStore(); } catch (error) { job.editorDraft = previous; throw error; }
    res.json({ draft: job.editorDraft });
  });
  app.delete('/api/jobs/:id/draft', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id);
    if (!job) { res.status(404).json({ error: 'Export not found.' }); return; }
    if (job.editorDraft && req.get('If-Match') !== job.editorDraft.token) { res.status(409).json({ error: 'A newer draft exists. Reopen the editor before discarding it.' }); return; }
    const previous = { editorDraft: job.editorDraft, retentionResetAt: job.retentionResetAt };
    delete job.editorDraft; job.retentionResetAt = new Date().toISOString();
    try { await saveStore(); } catch (error) { Object.assign(job, previous); throw error; }
    res.json({ ok: true });
  });
  app.get('/api/jobs/:id/source-status', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id);
    if (!job) { res.status(404).json({ error: 'Export not found.' }); return; }
    const source = state.sources.find(source => source.id === job.sourceId);
    let available = false;
    if (source) try { await assertLinkedSourceUnchanged(source); await stat(source.filePath); available = true; } catch { /* Return a recovery path, not a broken player. */ }
    const fingerprint = source?.fingerprint || historyRecords({ jobId: job.id })[0]?.sourceFingerprint;
    res.json({ available, name: job.sourceName, canMatch: Boolean(fingerprint), candidates: state.sources.filter(item => fingerprint && item.fingerprint === fingerprint && item.id !== job.sourceId).map(publicSource) });
  });
  app.post('/api/jobs/:id/reconnect', async (req, res) => {
    const job = state.jobs.find(job => job.id === req.params.id);
    const parsed = z.object({ sourceId: z.string().max(120) }).strict().safeParse(req.body);
    const source = parsed.success ? state.sources.find(source => source.id === parsed.data.sourceId) : undefined;
    if (!job?.editPlan || !source) { res.status(404).json({ error: 'Import the original video first, then choose it here.' }); return; }
    if (['queued','processing'].includes(job.status) || publishingJobs.has(job.id)) { res.status(409).json({ error: 'Wait for this export to finish before reconnecting it.' }); return; }
    const fingerprint = state.sources.find(item => item.id === job.sourceId)?.fingerprint || historyRecords({ jobId: job.id })[0]?.sourceFingerprint;
    if (!fingerprint || source.fingerprint !== fingerprint) { res.status(409).json({ error: 'Choose the unchanged original video. Its contents must match so saved cuts stay accurate.' }); return; }
    await assertLinkedSourceUnchanged(source); await stat(source.filePath);
    const previous = structuredClone(job);
    job.sourceId = source.id; job.editPlan.sourceId = source.id;
    if (job.editorDraft) {
      const content = JSON.parse(job.editorDraft.content);
      content.draft.sourceId = source.id;
      if (content.promptAnchor?.plan) content.promptAnchor.plan.sourceId = source.id;
      job.editorDraft = { ...job.editorDraft, content: JSON.stringify(content), token: randomUUID(), savedAt: new Date().toISOString() };
    }
    try { await saveStore(); } catch (error) { Object.assign(job, previous); throw error; }
    res.json(publicJob(job));
  });
  app.patch('/api/sources/:id/project', async (req, res) => {
    const source = state.sources.find(source => source.id === req.params.id), parsed = projectSchema.safeParse(req.body);
    if (!source || !parsed.success) { res.status(400).json({ error: 'Choose a source and a project name up to 60 characters.' }); return; }
    const jobs = state.jobs.filter(job => job.sourceId === source.id), entries = historyRecords({ fingerprint: source.fingerprint });
    const previous = [source.project, ...jobs.map(job => job.project)];
    source.project = parsed.data.project;
    for (const job of jobs) job.project = parsed.data.project;
    for (const entry of entries) if (entry.sourceId === source.id) entry.project = parsed.data.project;
    try { await saveStore(entries); } catch (error) { source.project = previous[0]; jobs.forEach((job, i) => job.project = previous[i + 1]); throw error; }
    res.json({ source: publicSource(source), jobs: jobs.map(publicJob) });
  });
  // Each browser owns only its own short-draft pins; another browser cannot clear them.
  app.put('/api/draft-sources/:owner', async (req, res) => {
    const parsed = z.object({ sourceIds: z.array(z.string().max(120)).max(200) }).strict().safeParse(req.body);
    if (!parsed.success || !z.uuid().safeParse(req.params.owner).success) { res.status(400).json({ error: 'Invalid draft source list.' }); return; }
    const owner = String(req.params.owner), wanted = new Set(parsed.data.sourceIds);
    const previous = state.sources.map(source => ({ source, owners: structuredClone(source.draftOwners) }));
    for (const source of state.sources) {
      source.draftOwners ??= {};
      if (wanted.has(source.id)) source.draftOwners[owner] = [source.id]; else delete source.draftOwners[owner];
    }
    try { await saveStore(); } catch (error) { previous.forEach(item => item.source.draftOwners = item.owners); throw error; }
    res.json({ ok: true });
  });
  app.delete('/api/sources/:id/draft-protection', async (req, res) => {
    const source = state.sources.find(source => source.id === req.params.id);
    if (!source || req.body?.release !== true) { res.status(400).json({ error: 'Confirm releasing short-draft protection for this source.' }); return; }
    const previous = source.draftOwners;
    delete source.draftOwners;
    try { await saveStore(); } catch (error) { source.draftOwners = previous; throw error; }
    res.json(publicSource(source));
  });
  app.patch('/api/batches/:id/keep', async (req, res) => {
    const jobs = state.jobs.filter(job => job.batchId === req.params.id && job.status === 'completed');
    if (!jobs.length) { res.status(404).json({ error: 'No completed exports in this collection.' }); return; }
    const previous = jobs.map(job => job.keptAt);
    for (const job of jobs) job.keptAt ??= new Date().toISOString();
    try { await saveStore(); } catch (error) { jobs.forEach((job, i) => job.keptAt = previous[i]); throw error; }
    res.json({ jobs: jobs.map(publicJob) });
  });
  app.get('/api/exports/accepted.zip', async (req, res) => {
    const ids = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
    if (!ids.length || ids.length > 300) { res.status(400).json({ error: 'Choose between 1 and 300 accepted exports.' }); return; }
    const jobs = state.jobs.filter(job => ids.includes(job.id) && job.status === 'completed' && reviewStatus(historyRecords({ jobId: job.id })[0]?.measurements?.review) === 'accepted');
    if (!jobs.length) { res.status(404).json({ error: 'No accepted exports are still available.' }); return; }
    for (const job of jobs) await stat(job.outputPath);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    archive.on('error', error => res.destroy(error)); archive.on('warning', error => res.destroy(error));
    res.attachment('accepted-clips.zip'); res.on('close', () => archive.abort()); archive.pipe(res);
    jobs.forEach((job, index) => {
      const name = `${index + 1}-${(job.exportName || job.summary?.title || 'clip').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 70)}`;
      archive.file(job.outputPath, { name: `${name}.mp4` });
      if (job.captionPath) archive.file(job.captionPath, { name: `${name}.srt` });
    });
    await archive.finalize();
  });
}
