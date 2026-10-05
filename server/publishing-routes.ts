import { createHash } from 'node:crypto';
import { Router, type Express, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { contentLimit, platformForChannel, platformSchema, postDraftSchema, promotionProfileSchema, scheduleSchema, validPublicationUrl,
  type PostDraft, type PromotionProfile, type Publication, type ScheduleRequest } from '../shared/publishing.js';
import { exportTitle } from '../shared/export-presentation.js';
import { publishingRecords, savePublishing, state, saveStore, publicJob, historyRecords } from './store.js';
import { PostizClient, PostizError, postizConfiguration } from './postiz.js';
import { fallbackPostDraft, generatePostDraft } from './post-copy.js';
import { editorialAIConfigured } from './editorial-provider.js';
import { AIRequestError } from './ai-errors.js';
import { publishingJobs } from './publishing-lock.js';
import { appStoreImportSchema } from '../shared/app-store.js';
import { AppStoreError, importAppStoreProfile } from './app-store.js';
import { languageNameSchema, publishingLanguageSchema } from '../shared/publishing-language.js';

const activePublications = new Set(['uploading', 'submitting', 'scheduled', 'published', 'uncertain', 'cancelling', 'draft']);
export function publicationFingerprint(jobId: string, endpoint: string, request: ScheduleRequest) {
  return createHash('sha256').update(JSON.stringify({ jobId, endpoint, channelId: request.channelId,
    content: request.content, date: new Date(request.date).toISOString(), settings: request.settings })).digest('hex');
}
function availableJob(id: string) {
  const job = state.jobs.find(item => item.id === id);
  if (!job || job.status !== 'completed') throw new PostizError('This export is not available. Finish rendering or import it again.', 404);
  return job;
}
function publication(id: string) {
  const entry = publishingRecords<Publication>('publication', id)[0];
  if (!entry) throw new PostizError('Scheduled post not found.', 404);
  return entry;
}
function persist(entry: Publication) { entry.updatedAt = new Date().toISOString(); savePublishing('publication', entry.id, entry); return entry; }
function checkEndpoint(entry: Publication, client: PostizClient) {
  if (entry.endpoint !== client.config.endpoint) throw new PostizError('This post belongs to another Postiz server. Restore its configuration to manage it.', 409);
}
export function installPublishingRoutes(app: Express, options: { client?: PostizClient; generate?: typeof generatePostDraft; importApp?: typeof importAppStoreProfile } = {}) {
  const router = Router(), generating = new Set<string>(), updating = new Set<string>();
  let importing = false;
  const client = () => options.client ?? new PostizClient();
  // Never resend a post after a process restart: it may already exist remotely.
  for (const entry of publishingRecords<Publication>('publication')) {
    if (entry.state === 'submitting' || entry.state === 'cancelling') { entry.state = 'uncertain'; entry.statusMessage = 'The app restarted before Postiz confirmed this operation. Refresh the status or check Postiz.'; persist(entry); }
    else if (entry.state === 'uploading') { entry.state = 'failed'; entry.statusMessage = 'The upload was interrupted before scheduling. You can try again.'; persist(entry); }
  }
  router.get('/config', (_req, res) => {
    const config = options.client?.config ?? postizConfiguration();
    res.json({ configured: Boolean(config.apiKey), dashboard: config.dashboard, aiConfigured: editorialAIConfigured(), profiles: publishingRecords<PromotionProfile>('profile') });
  });
  router.put('/profiles/:id', (req, res) => {
    const profile = promotionProfileSchema.parse(req.body);
    if (profile.id !== req.params.id) throw new PostizError('Profile ID does not match.', 400);
    if (publishingRecords<PromotionProfile>('profile').length >= 100 && !publishingRecords('profile', profile.id).length) throw new PostizError('The workspace already has 100 app profiles.', 400);
    savePublishing('profile', profile.id, profile); res.json(profile);
  });
  router.post(['/profiles/import-store', '/profiles/import-app-store'], async (req, res) => {
    const input = appStoreImportSchema.parse(req.body);
    if (importing) throw new AppStoreError('An app import is already running. Wait for it to finish.', 409);
    importing = true;
    const disconnected = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.on('close', onClose);
    try { res.json(await (options.importApp ?? importAppStoreProfile)(input, AbortSignal.any([disconnected.signal, AbortSignal.timeout(60000)]))); }
    finally { importing = false; res.off('close', onClose); }
  });
  router.get('/channels', async (_req, res) => res.json({ channels: await client().channels() }));
  router.get('/publications', (req, res) => {
    const query = z.object({ jobId: z.string().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(req.query);
    const entries = publishingRecords<Publication>('publication').filter(entry => !query.jobId || entry.jobId === query.jobId);
    res.json({ publications: entries.slice(query.offset, query.offset + 50), total: entries.length });
  });
  router.get('/jobs/:id/draft', (req, res) => {
    const job = availableJob(String(req.params.id)), platform = platformSchema.parse(req.query.platform);
    res.json(publishingRecords<PostDraft>('draft', `${job.id}:${platform}`)[0] ?? fallbackPostDraft(job, platform));
  });
  router.put('/jobs/:id/draft', (req, res) => {
    const job = availableJob(String(req.params.id));
    const edits = postDraftSchema.pick({ platform: true, title: true, short: true, long: true, hashtags: true, selected: true }).strict().parse(req.body);
    const id = `${job.id}:${edits.platform}`;
    const original = publishingRecords<PostDraft>('draft', id)[0] ?? fallbackPostDraft(job, edits.platform);
    const draft = { ...original, ...edits, trends: original.trends.filter(item => edits.hashtags.includes(item.tag)) };
    savePublishing('draft', id, draft); res.json(draft);
  });
  router.post('/jobs/:id/generate', async (req, res) => {
    const job = availableJob(String(req.params.id));
    const { platform, profileId, language } = z.object({ platform: platformSchema, profileId: z.uuid(), language: languageNameSchema.optional() }).strict().parse(req.body);
    const profile = publishingRecords<PromotionProfile>('profile', profileId)[0];
    if (!profile) throw new PostizError('Save an app profile before generating its post copy.', 400);
    const id = `${job.id}:${platform}`;
    if (generating.has(id)) throw new PostizError('Post copy is already being generated for this export.', 409);
    generating.add(id);
    try {
      const draft = await (options.generate ?? generatePostDraft)(job, platform, { ...profile, language: language ?? publishingLanguageSchema.parse(profile.language) }, AbortSignal.timeout(65000));
      availableJob(job.id); savePublishing('draft', id, draft); res.json(draft);
    } finally { generating.delete(id); }
  });
  router.post('/jobs/:id/schedule', async (req, res) => {
    const job = availableJob(String(req.params.id)), request = scheduleSchema.parse(req.body), api = client();
    const previous = publishingRecords<Publication>('publication', request.requestId)[0];
    const fingerprint = publicationFingerprint(job.id, api.config.endpoint, request);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PostizError('This request was already used with different content. Refresh before scheduling.', 409);
      res.json({ publication: previous, job: publicJob(job) }); return;
    }
    const duplicate = publishingRecords<Publication>('publication').find(entry => entry.fingerprint === fingerprint && activePublications.has(entry.state));
    if (duplicate) { res.json({ publication: duplicate, job: publicJob(job) }); return; }
    if (publishingRecords<Publication>('publication').some(entry => entry.jobId === job.id && entry.request.channelId === request.channelId && entry.endpoint === api.config.endpoint && ['uncertain', 'submitting', 'cancelling'].includes(entry.state)))
      throw new PostizError('An earlier post has an unconfirmed status. Refresh it or check Postiz before scheduling another copy.', 409);
    const date = Date.parse(request.date);
    if (date < Date.now() + 120000 || date > Date.now() + 366 * 24 * 3600000) throw new PostizError('Choose a date at least two minutes ahead and within the next year.', 400);
    if (publishingJobs.has(job.id)) throw new PostizError('This export is already being sent to Postiz.', 409);
    publishingJobs.add(job.id);
    const entry: Publication = { id: request.requestId, jobId: job.id, exportTitle: exportTitle(job), request: { ...request, date: new Date(date).toISOString() }, fingerprint,
      endpoint: api.config.endpoint, channelName: '', platform: platformForChannel(request.settings.__type)!, state: 'uploading', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    try {
      const oldKeptAt = job.keptAt; job.keptAt ??= new Date().toISOString();
      try { await saveStore(); } catch (error) { job.keptAt = oldKeptAt; throw error; }
      persist(entry);
      const channel = (await api.channels()).find(item => item.id === request.channelId);
      if (!channel || channel.disabled || channel.identifier !== request.settings.__type) throw new PostizError('Choose a connected account matching this post’s platform.', 400);
      entry.channelName = channel.name; persist(entry);
      const rules = await api.settings(channel.id);
      const limit = Math.min(contentLimit(entry.platform), rules.maxLength ?? Infinity);
      if ([...request.content].length > limit) throw new PostizError(`This channel allows ${limit} characters, including hashtags. Shorten the post first.`, 400);
      entry.media = await api.upload(job.outputPath); persist(entry);
      if (date < Date.now() + 15000) throw new PostizError('The selected time passed during the upload. Choose a later time and try again.', 400);
      entry.state = 'submitting'; persist(entry);
      entry.postId = await api.schedule(entry.request, entry.media); entry.state = 'scheduled'; delete entry.statusMessage; persist(entry);
      res.status(201).json({ publication: entry, job: publicJob(job) });
    } catch (error) {
      // Once creation was attempted, a lost response or local save failure must not trigger another POST.
      if (entry.state === 'submitting' || entry.state === 'scheduled') entry.state = error instanceof PostizError && !error.uncertain ? 'failed' : 'uncertain';
      else entry.state = 'failed';
      entry.statusMessage = error instanceof PostizError ? error.message : 'The operation could not finish. Check Postiz before trying again.';
      persist(entry); throw error;
    } finally { publishingJobs.delete(job.id); }
  });
  router.post('/publications/:id/refresh', async (req, res) => {
    const entry = publication(String(req.params.id)), api = client(); checkEndpoint(entry, api);
    if (updating.has(entry.id) || publishingJobs.has(entry.jobId)) throw new PostizError('Wait for the current Postiz operation to finish.', 409);
    updating.add(entry.id);
    try {
      const posts = await api.posts(entry.request.date);
      const matches = posts.filter(post => entry.postId ? post.id === entry.postId : post.integration.id === entry.request.channelId &&
        Date.parse(post.publishDate) === Date.parse(entry.request.date) && post.content === entry.request.content);
      if (matches.length === 1) {
        const post = matches[0]; entry.postId = post.id;
        entry.state = ({ QUEUE: 'scheduled', PUBLISHED: 'published', ERROR: 'failed', DRAFT: 'draft' } as const)[post.state];
        entry.releaseUrl = post.releaseURL && validPublicationUrl(entry.platform, post.releaseURL) ? post.releaseURL : undefined;
        entry.statusMessage = post.state === 'ERROR' ? 'The platform rejected this post. Open Postiz to see the channel’s error and correct it.' : undefined;
        if (entry.state === 'published') {
          const history = historyRecords({ jobId: entry.jobId });
          for (const item of history) {
            const record = { id: entry.id, platform: entry.platform, publishedAt: post.publishDate, account: entry.channelName, url: entry.releaseUrl };
            item.publications = [...item.publications.filter(record => record.id !== entry.id), record];
          }
          if (history.length) await saveStore(history);
        }
      } else if (entry.state !== 'cancelled' && entry.state !== 'failed') {
        entry.state = 'uncertain'; entry.statusMessage = 'No unique matching post was found. Check the Postiz calendar before scheduling another copy.';
      }
      res.json(persist(entry));
    } finally { updating.delete(entry.id); }
  });
  router.delete('/publications/:id', async (req, res) => {
    const entry = publication(String(req.params.id)), api = client(); checkEndpoint(entry, api);
    if (entry.state === 'cancelled') { res.json(entry); return; }
    if (updating.has(entry.id) || publishingJobs.has(entry.jobId)) throw new PostizError('Wait for the current Postiz operation to finish.', 409);
    if (!entry.postId || !['scheduled', 'draft', 'failed'].includes(entry.state)) throw new PostizError('Refresh this post or open Postiz before cancelling it.', 409);
    if (entry.state === 'scheduled' && Date.parse(entry.request.date) <= Date.now() + 60000) throw new PostizError('This post may already be publishing. Check Postiz directly.', 409);
    updating.add(entry.id); entry.state = 'cancelling'; persist(entry);
    try {
      const current = (await api.posts(entry.request.date)).find(post => post.id === entry.postId);
      if (current?.state === 'PUBLISHED') { entry.state = 'published'; persist(entry); throw new PostizError('This post is already published. Manage it on the social platform.', 409); }
      try { await api.cancel(entry.postId); } catch (error) { if (!(error instanceof PostizError) || error.status !== 404) throw error; }
      entry.state = 'cancelled'; delete entry.statusMessage; res.json(persist(entry));
    } catch (error) { if (entry.state === 'cancelling') { entry.state = 'uncertain'; entry.statusMessage = 'Cancellation was not confirmed. Refresh the status or check Postiz.'; persist(entry); } throw error; }
    finally { updating.delete(entry.id); }
  });
  router.post('/publications/:id/resolve', (req, res) => {
    const entry = publication(String(req.params.id));
    z.object({ confirmedAbsentInPostiz: z.literal(true) }).strict().parse(req.body);
    if (entry.state !== 'uncertain' || publishingJobs.has(entry.jobId) || updating.has(entry.id)) throw new PostizError('Refresh this post before resolving its status.', 409);
    entry.state = 'failed'; entry.statusMessage = 'You confirmed that this post is absent from Postiz. It can now be scheduled again.';
    res.json(persist(entry));
  });
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: `Check the publishing form: ${error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).slice(0, 3).join('; ')}` }); return; }
    if (error instanceof PostizError || error instanceof AppStoreError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof AIRequestError) { res.status(502).json({ error: error.message }); return; }
    next(error);
  };
  router.use(errors); app.use('/api/publishing', router);
}
