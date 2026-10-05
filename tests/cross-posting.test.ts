import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CrossPostResult, ScheduleRequest } from '../shared/publishing.js';

// All remote calls use this in-memory Postiz client; no social accounts are contacted.
test('cross-posting shares uploads across accounts and platforms, isolates failures and never repeats confirmed or uncertain posts', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remix-cross-post-')); process.env.DATA_DIR = dir; process.env.AUTO_AI = 'false';
  const { PostizClient, PostizError } = await import('../server/postiz.js');
  const { initStore, closeStore, state, saveStore, publishingRecords } = await import('../server/store.js');
  const { installPublishingRoutes } = await import('../server/publishing-routes.js');
  const { publishingJobs } = await import('../server/publishing-lock.js');
  const { DEFAULT_SETTINGS } = await import('../shared/types.js');
  const { default: express } = await import('express');
  const { config } = await import('../server/config.js');
  assert.equal(config.dataDir, dir, 'The publishing fixture must never open the local workspace');
  await initStore();
  const file = path.join(dir, 'video.mp4'); await writeFile(file, 'fixture');
  const job = { id: 'job', sourceId: 'source', sourceName: 'Video', variant: 1, batchId: 'batch', status: 'completed' as const, progress: 100, createdAt: new Date().toISOString(), settings: DEFAULT_SETTINGS, outputPath: file };
  state.jobs.push(job); await saveStore();
  const channels = ['instagram', 'instagram-standalone', 'tiktok', 'tiktok', 'youtube', 'youtube'].map((identifier, i) => ({ id: `account-${i}`, name: `Account ${i}`, identifier, disabled: false }));
  let uploads = 0, postCalls = 0, failAccount = '', uncertainAccount = '', failUpload = false, release!: () => void;
  let uploadGate: Promise<void> | undefined;
  const posted: string[] = [];
  const client = new PostizClient({ endpoint: 'https://fixture.postiz.test/public/v1', dashboard: 'https://fixture.postiz.test', apiKey: 'fixture' });
  client.channels = async () => channels;
  client.settings = async id => ({ maxLength: id === failAccount ? 1 : 5000 });
  client.upload = async () => { uploads++; await uploadGate; if (failUpload) throw new PostizError('Upload unavailable'); return { id: 'shared-media', path: 'https://uploads.postiz.com/video.mp4' }; };
  client.schedule = async (request, media) => {
    postCalls++; posted.push(request.channelId); assert.equal(media.id, 'shared-media');
    assert.equal(request.settings.__type, channels.find(channel => channel.id === request.channelId)!.identifier);
    if (request.channelId === uncertainAccount) throw new PostizError('Response lost', 502, true);
    return `post-${postCalls}`;
  };
  const app = express(); app.use(express.json()); installPublishingRoutes(app, { client });
  const server = createServer(app).listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/publishing/jobs/job`;
  const call = (requests: ScheduleRequest[]) => fetch(`${base}/schedule-batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) });
  const requests = (content: string): ScheduleRequest[] => channels.map(channel => ({ requestId: randomUUID(), channelId: channel.id, date: new Date(Date.now() + 3600000).toISOString(), timezone: 'UTC', content,
    settings: channel.identifier === 'tiktok' ? { __type: 'tiktok', title: 'Try the app', privacy_level: 'PUBLIC_TO_EVERYONE', duet: false, stitch: false, comment: true, autoAddMusic: 'no', brand_content_toggle: false, brand_organic_toggle: true, video_made_with_ai: false, content_posting_method: 'DIRECT_POST' }
      : channel.identifier === 'youtube' ? { __type: 'youtube', title: 'Try the app', type: 'public', selfDeclaredMadeForKids: 'no', tags: [] }
        : { __type: channel.identifier as 'instagram' | 'instagram-standalone', post_type: 'post', is_trial_reel: false, collaborators: [] } }));
  try {
    assert.equal((await call([])).status, 400);
    const invalid = requests('Invalid'); assert.equal((await call([invalid[0], invalid[0]])).status, 400); assert.equal(uploads, 0);
    const first = requests('First caption'); failAccount = 'account-1';
    uploadGate = new Promise<void>(resolve => { release = resolve; });
    const pending = call(first);
    while (!uploads) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(publishingJobs.has('job'), true);
    assert.equal((await call(requests('Concurrent'))).status, 409);
    release(); uploadGate = undefined;
    const response = await pending; assert.equal(response.status, 200);
    const data = await response.json() as { results: CrossPostResult[]; job: { keptAt: string } };
    assert.equal(data.results.length, 6); assert.equal(data.results.filter(item => item.publication?.state === 'scheduled').length, 5);
    assert.equal(data.results.find(item => item.channelId === failAccount)?.publication?.state, 'failed');
    assert.equal(uploads, 1); assert.equal(postCalls, 5); assert.ok(data.job.keptAt); assert.equal(publishingJobs.has('job'), false);
    await call(first); assert.equal(postCalls, 5); assert.equal(uploads, 1, 'Identical retry does not resend any prior operation');
    const retry = first.map(request => request.channelId === failAccount ? { ...request, requestId: randomUUID() } : request); failAccount = '';
    await call(retry); assert.equal(postCalls, 6); assert.equal(uploads, 2); assert.equal(posted.filter(id => id === 'account-0').length, 1);
    const duplicates = retry.map(request => ({ ...request, requestId: randomUUID() })); await call(duplicates); assert.equal(postCalls, 6); assert.equal(uploads, 2);
    const conflict = await (await call([{ ...first[0], content: 'Changed after its ID was used' }])).json();
    assert.equal(conflict.results[0].publication, undefined); assert.match(conflict.results[0].message, /different content/u);
    uncertainAccount = 'account-2'; const uncertain = requests('Another caption');
    const partial = await (await call(uncertain)).json(); assert.equal(partial.results.filter((item: CrossPostResult) => item.publication?.state === 'scheduled').length, 5);
    assert.equal(partial.results.find((item: CrossPostResult) => item.channelId === uncertainAccount).publication.state, 'uncertain');
    const before = postCalls; await call(uncertain); assert.equal(postCalls, before);
    const blocked = await (await call([{ ...uncertain[2], requestId: randomUUID(), content: 'Do not send this' }])).json();
    assert.match(blocked.results[0].message, /unconfirmed/u); assert.equal(postCalls, before);
    uncertainAccount = ''; failUpload = true;
    const failures = requests('Failed upload').filter(request => request.channelId !== 'account-2'), uploadsBefore = uploads;
    const failed = await (await call(failures)).json(); assert.equal(failed.results.every((item: CrossPostResult) => item.publication?.state === 'failed'), true);
    assert.equal(uploads, uploadsBefore + 1, 'The batch does not automatically retry a failed upload for every account');
    assert.equal(postCalls, before); assert.ok(publishingRecords('publication').length >= 17);
  } finally { release?.(); await new Promise<void>(resolve => server.close(() => resolve())); await closeStore(); await rm(dir, { recursive: true, force: true }); }
});
