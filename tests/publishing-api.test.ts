import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PostDraft, PromotionProfile, Publication, ScheduleRequest } from '../shared/publishing.js';

test('post copy and Postiz scheduling persist, protect media, deduplicate and reconcile uncertain writes', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remix-publishing-'));
  process.env.DATA_DIR = dir; process.env.AUTO_AI = 'false'; process.env.POSTIZ_API_KEY = 'fixture-secret-never-public';
  let postCalls = 0, uploads = 0, cancelled = 0, mode = 'normal';
  const remote: { id: string; content: string; publishDate: string; state: string; releaseURL?: string; integration: { id: string } }[] = [];
  let uploadGate: Promise<void> | undefined;
  const mock = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, process.env.POSTIZ_API_KEY);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const send = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/public/v1/integrations') { send([{ id: 'tiktok-account', name: 'Focus TikTok', identifier: 'tiktok', disabled: false }, { id: 'youtube-account', name: 'Focus YouTube', identifier: 'youtube', disabled: false }]); return; }
    if (req.url?.startsWith('/public/v1/integration-settings/')) { send({ output: { maxLength: 2200, rules: 'Video required' } }); return; }
    if (req.url === '/public/v1/upload') { uploads++; assert.match(req.headers['content-type']!, /multipart\/form-data/u); assert.ok(Buffer.concat(chunks).includes(Buffer.from('fixture-video'))); await uploadGate; send({ id: 'media', path: 'https://uploads.postiz.com/video.mp4' }); return; }
    if (req.url === '/public/v1/posts' && req.method === 'POST') {
      postCalls++; const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.type, 'schedule'); assert.equal(body.posts.length, 1);
      const item = { id: randomUUID(), content: body.posts[0].value[0].content, publishDate: body.date, state: 'QUEUE', integration: { id: body.posts[0].integration.id } }; remote.push(item);
      if (mode === 'lost-response') { send({ error: process.env.POSTIZ_API_KEY }, 500); return; }
      send([{ postId: item.id, integration: item.integration.id }]); return;
    }
    if (req.url?.startsWith('/public/v1/posts?')) { send({ posts: remote }); return; }
    if (req.url?.startsWith('/public/v1/posts/') && req.method === 'DELETE') { const index = remote.findIndex(post => post.id === req.url!.split('/').at(-1)); if (index < 0) { send({}, 404); return; } cancelled++; remote.splice(index, 1); send({ ok: true }); return; }
    send({}, 404);
  });
  const listen = async (server: Server) => { server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
  const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  process.env.POSTIZ_API_URL = `${await listen(mock)}/public/v1`;
  const { initStore, state, saveStore, closeStore, publishingRecords, savePublishing, historyRecords } = await import('../server/store.js');
  const { createApp } = await import('../server/app.js');
  const { cleanupExpired } = await import('../server/queue.js');
  const { config, paths } = await import('../server/config.js');
  const { DEFAULT_SETTINGS } = await import('../shared/types.js');
  const { historyEntry } = await import('../server/history.js');
  await initStore();
  const source = { id: 'source', name: 'Source', filePath: path.join(paths.uploads, 'source.mp4'), thumbnailPath: path.join(paths.thumbnails, 'source.jpg'), thumbnailUrl: '', fingerprint: 'a'.repeat(64), duration: 12, width: 360, height: 640, fps: 24, hasAudio: false, size: 13, createdAt: new Date().toISOString() };
  const job = { id: 'job', sourceId: source.id, sourceName: 'Source', variant: 1, batchId: 'batch', status: 'completed' as const, progress: 100, createdAt: source.createdAt, settings: { ...DEFAULT_SETTINGS, hookText: 'Find your focus' }, outputPath: path.join(paths.outputs, 'job.mp4') };
  await writeFile(job.outputPath, 'fixture-video'); await writeFile(source.filePath, 'fixture-video');
  state.sources.push(source); state.jobs.push(job); await saveStore([historyEntry(source, job)!]);
  let server = createServer(createApp());
  let base = await listen(server);
  const call = (url: string, method = 'GET', body?: unknown) => fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const profile: PromotionProfile = { id: randomUUID(), name: 'Focus', benefit: 'Plan focus sessions', audience: 'Students', features: 'Timer', callToAction: 'Try Focus', storeUrl: '', country: 'FR', language: 'French', hashtags: ['#Focus'] };
  const scheduled: ScheduleRequest = { requestId: randomUUID(), channelId: 'tiktok-account', date: new Date(Date.now() + 3600000).toISOString(), timezone: 'Europe/Paris', content: 'Try Focus\n\n#Focus',
    settings: { __type: 'tiktok', title: 'Find your focus', privacy_level: 'PUBLIC_TO_EVERYONE', duet: false, stitch: false, comment: true, autoAddMusic: 'no', brand_content_toggle: false, brand_organic_toggle: true, video_made_with_ai: false, content_posting_method: 'DIRECT_POST' } };
  try {
    const configuration = await (await call('/api/publishing/config')).text(); assert.ok(!configuration.includes(process.env.POSTIZ_API_KEY!)); assert.match(configuration, /"configured":true/u);
    assert.equal((await call(`/api/publishing/profiles/${profile.id}`, 'PUT', profile)).status, 200);
    const generated = await call('/api/publishing/jobs/job/generate', 'POST', { platform: 'tiktok', profileId: profile.id });
    assert.equal(generated.status, 200); const draft = await generated.json() as PostDraft; assert.equal(draft.provider, 'hook'); assert.equal(draft.short, 'Find your focus');
    const edit = { platform: draft.platform, title: draft.title, short: 'A manual app caption', long: 'A longer caption', hashtags: draft.hashtags, selected: 'short' };
    assert.equal((await call('/api/publishing/jobs/job/draft', 'PUT', edit)).status, 200);
    assert.equal((await (await call('/api/publishing/jobs/job/draft?platform=tiktok')).json()).short, edit.short);
    assert.equal((await call('/api/publishing/jobs/job/schedule', 'POST', { ...scheduled, date: new Date().toISOString() })).status, 400);
    assert.equal((await call('/api/publishing/jobs/job/schedule', 'POST', { ...scheduled, requestId: randomUUID(), channelId: 'youtube-account' })).status, 400);
    assert.equal(postCalls, 0);

    let releaseUpload!: () => void; uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    const pending = call('/api/publishing/jobs/job/schedule', 'POST', scheduled);
    while (!uploads) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await call('/api/jobs/job/keep', 'PATCH', { keep: false })).status, 409);
    assert.equal((await call('/api/sources/source', 'DELETE')).status, 409);
    assert.equal((await call('/api/batches/batch', 'DELETE')).status, 409);
    state.jobs[0].finishedAt = new Date(Date.now() - config.retentionMs - 60000).toISOString();
    await cleanupExpired(); await access(job.outputPath);
    releaseUpload(); const response = await pending; assert.equal(response.status, 201, await response.clone().text());
    const saved = (await response.json()).publication as Publication; assert.equal(saved.state, 'scheduled'); assert.ok(state.jobs[0].keptAt);
    assert.equal(postCalls, 1); assert.equal(uploads, 1);
    const twice = await call('/api/publishing/jobs/job/schedule', 'POST', scheduled); assert.equal(twice.status, 200);
    const duplicate = await call('/api/publishing/jobs/job/schedule', 'POST', { ...scheduled, requestId: randomUUID() }); assert.equal((await duplicate.json()).publication.id, saved.id);
    assert.equal(postCalls, 1); assert.equal(uploads, 1);
    assert.equal((await call('/api/publishing/jobs/job/schedule', 'POST', { ...scheduled, content: 'Changed content' })).status, 409);
    assert.equal((await call(`/api/publishing/publications/${saved.id}`, 'DELETE')).status, 200); assert.equal(cancelled, 1);

    mode = 'lost-response'; const uncertainRequest = { ...scheduled, requestId: randomUUID(), content: 'Another caption' };
    const uncertain = await call('/api/publishing/jobs/job/schedule', 'POST', uncertainRequest); assert.equal(uncertain.status, 502);
    assert.ok(!(await uncertain.text()).includes(process.env.POSTIZ_API_KEY!));
    assert.equal(publishingRecords<Publication>('publication', uncertainRequest.requestId)[0].state, 'uncertain');
    assert.equal((await call('/api/publishing/jobs/job/schedule', 'POST', { ...uncertainRequest, requestId: randomUUID(), date: new Date(Date.now() + 7200000).toISOString() })).status, 409);
    assert.equal(postCalls, 2);
    const refreshed = await call(`/api/publishing/publications/${uncertainRequest.requestId}/refresh`, 'POST'); assert.equal((await refreshed.json()).state, 'scheduled');
    remote[0].state = 'ERROR';
    const platformFailure = await (await call(`/api/publishing/publications/${uncertainRequest.requestId}/refresh`, 'POST')).json();
    assert.equal(platformFailure.state, 'failed'); assert.ok(platformFailure.statusMessage);
    assert.equal(platformFailure.error, undefined); assert.equal(platformFailure.diagnostic, undefined, 'Saved platform reports must not become new Help errors');
    remote[0].state = 'PUBLISHED'; remote[0].releaseURL = 'https://www.tiktok.com/@focus/video/123';
    const published = await call(`/api/publishing/publications/${uncertainRequest.requestId}/refresh`, 'POST'); assert.equal((await published.json()).state, 'published');
    assert.equal(historyRecords({ jobId: 'job' })[0].publications[0].url, remote[0].releaseURL);
    assert.equal((await call(`/api/publishing/publications/${uncertainRequest.requestId}`, 'DELETE')).status, 409);
    assert.equal(cancelled, 1);

    // Recovery is conservative across restarts; the durable schedule survives local export cleanup.
    const interrupted = { ...saved, id: randomUUID(), state: 'submitting' as const }; savePublishing('publication', interrupted.id, interrupted);
    await close(server); closeStore(); await initStore(); server = createServer(createApp()); base = await listen(server);
    assert.equal(publishingRecords<Publication>('publication', interrupted.id)[0].state, 'uncertain');
    assert.equal(publishingRecords<PromotionProfile>('profile', profile.id)[0].name, 'Focus');
    assert.equal(publishingRecords<PostDraft>('draft', 'job:tiktok')[0].short, edit.short);
    await call('/api/jobs/job/keep', 'PATCH', { keep: false }); await call('/api/batches/batch', 'DELETE');
    assert.equal(state.jobs.length, 0); assert.ok(publishingRecords('publication').length >= 3);
    const all = await (await call('/api/publishing/publications')).text(); assert.ok(all.includes('published')); assert.ok(!all.includes(process.env.POSTIZ_API_KEY!));
    assert.equal((await (await call('/api/publishing/publications?jobId=another-export')).json()).total, 0);
    assert.equal((await (await call('/api/publishing/publications?jobId=job&offset=100')).json()).publications.length, 0);
  } finally { await close(server); await close(mock); closeStore(); await rm(dir, { recursive: true, force: true }); }
});
