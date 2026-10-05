import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PromotionProfile } from '../shared/publishing.js';

test('post language overrides are validated, persisted with copy and do not change the reusable app profile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remix-post-language-'));
  process.env.DATA_DIR = dir; process.env.AUTO_AI = 'false';
  const { initStore, state, closeStore, savePublishing, publishingRecords } = await import('../server/store.js');
  const { installPublishingRoutes } = await import('../server/publishing-routes.js');
  const { fallbackPostDraft } = await import('../server/post-copy.js');
  const { DEFAULT_SETTINGS } = await import('../shared/types.js');
  const { default: express } = await import('express');
  await initStore();
  state.jobs.push({ id: 'job', sourceId: 'source', sourceName: 'Video', variant: 1, batchId: 'batch', status: 'completed', progress: 100,
    createdAt: new Date().toISOString(), settings: DEFAULT_SETTINGS, outputPath: '/unused.mp4' });
  const profile: PromotionProfile = { id: randomUUID(), name: 'Pup', benefit: 'A journal', audience: 'Dog owners', features: '', callToAction: 'Try Pup', storeUrl: '', language: 'French', country: 'FR', hashtags: [] };
  savePublishing('profile', profile.id, profile);
  const app = express(); app.use(express.json()); let generations = 0;
  installPublishingRoutes(app, { generate: async (job, platform, selectedProfile) => {
    generations++; return { ...fallbackPostDraft(job, platform, selectedProfile), provider: 'deepseek', language: selectedProfile.language };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const call = (endpoint: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/publishing${endpoint}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  try {
    const input = { platform: 'tiktok', profileId: profile.id };
    const inherited = await call('/jobs/job/generate', 'POST', input);
    assert.equal(inherited.status, 200); assert.equal((await inherited.json()).language, 'French');
    const overridden = await call('/jobs/job/generate', 'POST', { ...input, language: 'English' });
    assert.equal(overridden.status, 200); assert.equal((await overridden.json()).language, 'English');
    assert.equal((await (await call('/jobs/job/draft?platform=tiktok')).json()).language, 'English');
    assert.equal(publishingRecords<PromotionProfile>('profile', profile.id)[0].language, 'French');
    for (const language of ['', 'x'.repeat(61), 'English\u0000']) assert.equal((await call('/jobs/job/generate', 'POST', { ...input, language })).status, 400);
    assert.equal(generations, 2);
    const edit = { platform: 'tiktok', title: 'A dog journal', short: 'Try Pup', long: 'A place for your daily notes.', hashtags: ['#DogJournal'], selected: 'short' };
    const saved = await call('/jobs/job/draft', 'PUT', edit); assert.equal(saved.status, 200); assert.equal((await saved.json()).language, 'English');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await closeStore(); await rm(dir, { recursive: true, force: true }); }
});
