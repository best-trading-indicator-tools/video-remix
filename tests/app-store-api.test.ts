import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppStoreSource } from '../shared/app-store.js';

test('App Store import API validates requests, serializes imports and saves provenance only with the reviewed profile', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remix-app-store-'));
  process.env.DATA_DIR = dir; process.env.AUTO_AI = 'false';
  const { initStore, closeStore, publishingRecords } = await import('../server/store.js');
  const { installPublishingRoutes } = await import('../server/publishing-routes.js');
  const { AppStoreError } = await import('../server/app-store.js');
  const { default: express } = await import('express');
  await initStore();
  const source: AppStoreSource = { provider: 'apple', appId: '6800214459', url: 'https://apps.apple.com/us/app/id6800214459', country: 'US', checkedAt: new Date().toISOString(),
    name: 'Pup AI', description: 'A dog journal.', developer: 'Developer', category: 'Health & Fitness', version: '1.5', languages: ['EN'], downloadPrice: 'Free', screenshots: [] };
  let release!: () => void, calls = 0, fail = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = express(); app.use(express.json());
  installPublishingRoutes(app, { importApp: async input => {
    calls++; if (fail) throw new AppStoreError('Not available in this country.', 404);
    assert.equal(input.country, 'US'); await gate;
    return { source, suggestions: { name: source.name, benefit: source.description, audience: '', features: '' }, summarized: false, note: 'Imported' };
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const call = (endpoint: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/publishing${endpoint}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const input = { url: source.url, country: 'US' };
  try {
    assert.equal((await call('/profiles/import-app-store', 'POST', { url: 'http://localhost/private' })).status, 400); assert.equal(calls, 0);
    const pending = call('/profiles/import-app-store', 'POST', input);
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await call('/profiles/import-app-store', 'POST', input)).status, 409);
    release(); const response = await pending; assert.equal(response.status, 200); assert.deepEqual((await response.json()).source, source);
    assert.equal(publishingRecords('profile').length, 0);
    const profile = { id: randomUUID(), name: source.name, benefit: source.description, audience: 'Dog owners', features: '', callToAction: 'Try Pup', storeUrl: source.url, country: 'US', language: 'English', hashtags: [], appStore: source };
    assert.equal((await call(`/profiles/${profile.id}`, 'PUT', profile)).status, 200);
    assert.deepEqual((await (await call('/config')).json()).profiles[0].appStore, source);
    fail = true; assert.equal((await call('/profiles/import-app-store', 'POST', input)).status, 404);
    fail = false; assert.equal((await call('/profiles/import-app-store', 'POST', input)).status, 200);
  } finally { release(); await new Promise<void>(resolve => server.close(() => resolve())); await closeStore(); await rm(dir, { recursive: true, force: true }); }
});
