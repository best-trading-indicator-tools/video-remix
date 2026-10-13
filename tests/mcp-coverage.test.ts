import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRemixMcpServer } from '../server/mcp/server.js';
import { RemixMcpService } from '../server/mcp/service.js';
import { RemixApi } from '../server/mcp/api.js';
import { DraftStore, autoPatchSchema, manualPatchSchema } from '../server/mcp/drafts.js';
import { MCP_API_EXCEPTIONS, MCP_FEATURE_COVERAGE } from '../server/mcp/coverage.js';
import { autoOptionsObject, settingsSchema } from '../server/schema.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

test('every app API and every editing setting has an explicit MCP coverage disposition', async () => {
  const recorded = new Set(MCP_FEATURE_COVERAGE.flatMap(group => [...group.routes] as string[]).concat(Object.keys(MCP_API_EXCEPTIONS)));
  const actual = new Set<string>();
  for (const file of await readdir('server')) {
    if (!file.endsWith('.ts')) continue;
    const content = await readFile(path.join('server', file), 'utf8');
    const prefix = file === 'publishing-routes.ts' ? '/api/publishing' : file === 'api-key-routes.ts' ? '/api/settings/api-keys' : '';
    for (const match of content.matchAll(/\b(app|router)\.(get|post|put|patch|delete)\(\s*(\[[^\]]+\]|"[^"\n]+"|'[^'\n]+')/gu)) {
      for (const entry of match[3]!.matchAll(/["']([^"']+)["']/gu)) {
        const route = `${match[1] === 'router' ? prefix : ''}${entry[1]}`;
        if (route.startsWith('/api/')) actual.add(`${match[2]!.toUpperCase()} ${route}`);
      }
    }
  }
  assert.deepEqual([...actual].filter(route => !recorded.has(route)), [], 'New APIs must add real MCP coverage or an explicit documented exception');
  assert.deepEqual([...recorded].filter(route => !actual.has(route)), [], 'Remove stale API coverage claims');
  for (const [schema, patch] of [[autoOptionsObject, autoPatchSchema], [settingsSchema, manualPatchSchema]] as const)
    assert.deepEqual(Object.keys(schema.shape).filter(key => key !== 'ownFootageSourceId' && !(key in patch.shape)), [], 'Every render setting must be available in typed MCP draft updates');
});

test('MCP workflow tools validate inputs, match app HTTP contracts, and process bounded streamed analysis batches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-workflows-'));
  const requests: { route: string; method: string; body: any; headers: any }[] = [];
  const sourceId = randomUUID(), jobId = randomUUID(), token = randomUUID();
  const apiServer = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : undefined;
    requests.push({ route: req.url!, method: req.method!, body, headers: req.headers });
    if (req.url === '/api/shorts/transcript') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write('{"type":"progress","message":"working","progress":10}\n');
      const line = JSON.stringify({ type: 'result', transcript: { language: 'fr', segments: [{ text: 'été', start: 0, end: 1, words: [] }] } });
      const bytes = Buffer.from(line); res.write(bytes.subarray(0, bytes.length - 4)); res.end(bytes.subarray(bytes.length - 4)); return;
    }
    if (req.url === '/api/shorts/discover') { res.setHeader('Content-Type', 'application/x-ndjson'); res.end('{"type":"error","message":"Fixture discovery unavailable"}\n'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ route: req.url, method: req.method, body }));
  });
  await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  const store = new DraftStore(path.join(directory, 'drafts.sqlite'));
  const api = new RemixApi(`http://127.0.0.1:${(apiServer.address() as import('node:net').AddressInfo).port}`);
  const server = createRemixMcpServer(new RemixMcpService(api, store));
  const client = new Client({ name: 'coverage-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.find(item => item.type === 'text'); assert.ok(text?.type === 'text');
    if (result.isError) throw new Error(text.text); return JSON.parse(text.text);
  };
  try {
    const tools = (await client.listTools()).tools;
    const names = new Set(tools.map(tool => tool.name));
    for (const group of MCP_FEATURE_COVERAGE) for (const name of group.tools) assert.ok(names.has(name), `${group.feature}: missing ${name}`);
    for (const tool of tools) assert.ok(MCP_FEATURE_COVERAGE.some(group => (group.tools as readonly string[]).includes(tool.name)), `Uncatalogued tool ${tool.name}`);
    const catalog = await call('get_editing_catalog'); assert.equal(catalog.titleDesigns.length, 4); assert.equal(catalog.animations.length, 6);
    const edits = { revision: 1, captions: [{ id: 'c1', start: 0, end: 1, text: 'Hello' }], framing: { captionStyle: { fontSize: 24, bottomPercent: 15, animation: 'pop' } } };
    const batch = { requests: [{ requestId: randomUUID(), channelId: 'fixture-account', content: 'Reviewed post copy', date: '2030-01-01T12:00:00Z', timezone: 'Europe/Paris', settings: { __type: 'instagram', post_type: 'post', is_trial_reel: false, collaborators: [] } }] };
    for (const [name, input, route, method, expected] of [
      ['download_media', { links: ['https://www.instagram.com/p/DeXDaIPFCju/?img_index=2', 'https://www.tiktok.com/@creator/photo/12345'] }, '/api/downloads', 'POST', { kind: 'media', stripMetadata: true, links: ['https://www.instagram.com/p/DeXDaIPFCju/?img_index=2', 'https://www.tiktok.com/@creator/photo/12345'] }],
      ['download_carousels', { links: ['https://www.instagram.com/p/DeXDaIPFCju/', 'https://www.tiktok.com/@chrissy_dogdiary/photo/7694716604277345544'] }, '/api/downloads', 'POST', { kind: 'carousel', links: ['https://www.instagram.com/p/DeXDaIPFCju/', 'https://www.tiktok.com/@chrissy_dogdiary/photo/7694716604277345544'] }],
      ['get_saved_edit', { jobId }, `/api/jobs/${jobId}/plan`, 'GET', undefined],
      ['preview_saved_edit', { jobId, changes: edits }, `/api/jobs/${jobId}/plan/preview`, 'POST', edits],
      ['prompt_saved_edit', { jobId, revision: 1, prompt: 'Make captions pop', draft: edits }, `/api/jobs/${jobId}/edit-prompt`, 'POST', { revision: 1, prompt: 'Make captions pop', draft: edits }],
      ['render_saved_edit', { jobId, changes: edits }, `/api/jobs/${jobId}/revisions`, 'POST', edits],
      ['save_saved_draft', { jobId, revision: 1, content: '{"draft":{}}', token }, `/api/jobs/${jobId}/draft`, 'PUT', { revision: 1, content: '{"draft":{}}', token }],
      ['discard_saved_draft', { jobId, token }, `/api/jobs/${jobId}/draft`, 'DELETE', undefined],
      ['keep_exports', { jobIds: [jobId] }, '/api/exports/keep', 'PATCH', { ids: [jobId] }],
      ['delete_exports', { jobIds: [jobId], confirm: true }, '/api/exports/selected', 'DELETE', { ids: [jobId], confirm: true }],
      ['reconnect_source', { jobId, sourceId }, `/api/jobs/${jobId}/reconnect`, 'POST', { sourceId }],
      ['protect_sources', { ownerId: jobId, sourceIds: [sourceId] }, `/api/draft-sources/${jobId}`, 'PUT', { sourceIds: [sourceId] }],
      ['preview_manual', { sourceId, settings: DEFAULT_SETTINGS }, '/api/previews', 'POST', { sourceId, settings: settingsSchema.parse(DEFAULT_SETTINGS) }],
      ['test_provider', { provider: 'deepseek' }, '/api/settings/api-keys/deepseek/test', 'POST', {}],
      ['schedule_posts', { jobId, batch, confirm: true }, `/api/publishing/jobs/${jobId}/schedule-batch`, 'POST', batch],
      ['cancel_publication', { publicationId: jobId, confirm: true }, `/api/publishing/publications/${jobId}`, 'DELETE', undefined],
    ] as const) {
      await call(name, input);
      const sent = requests.at(-1)!; assert.equal(sent.route, route); assert.equal(sent.method, method); assert.deepEqual(sent.body, expected);
      if (name === 'discard_saved_draft') assert.equal(sent.headers['if-match'], token);
      if (name === 'test_provider') assert.equal(sent.headers['x-remix-settings'], '1');
    }
    const beforeInvalid = requests.length;
    await assert.rejects(call('download_media', { links: ['https://example.com/image.jpg'] }));
    await assert.rejects(call('download_media', { links: [] }));
    await assert.rejects(call('download_media', { links: ['https://www.instagram.com/p/Post/?img_index=0'] }));
    await assert.rejects(call('download_carousels', { links: ['https://example.com/images'] }));
    await assert.rejects(call('download_carousels', { links: [] }));
    await assert.rejects(call('delete_exports', { jobIds: [jobId] }));
    await assert.rejects(call('render_saved_edit', { jobId, changes: { ...edits, unsupported: true } }));
    await assert.rejects(call('test_provider', { provider: 'deepseek', apiKey: 'never-pass-keys' }));
    await assert.rejects(call('schedule_posts', { jobId, batch }));
    await assert.rejects(call('start_analysis', { requests: [{ kind: 'pacing', request: { sourceId, cuts: [{ start: 0, end: .04 }], options: { mode: 'natural' } } }] }));
    await assert.rejects(call('start_analysis', { requests: [{ kind: 'pacing', request: { sourceId, cuts: [{ start: 0, end: 1, focalPoint: { x: .5, y: .5 } }], options: { mode: 'natural' } } }] }));
    assert.equal(requests.length, beforeInvalid);
    await assert.rejects(call('get_download_links', { accepted: true }));
    const links = await call('get_download_links', { jobId, jobIds: [jobId], downloadIds: [sourceId], accepted: true }); assert.ok(links.accepted.includes(`ids=${jobId}`));
    assert.equal(links.preview, `${api.baseUrl}/api/jobs/${jobId}/video`);
    assert.deepEqual(links.downloadThumbnails, [`${api.baseUrl}/api/downloads/${sourceId}/thumbnail`]);
    const started = await call('start_analysis', { requests: [{ kind: 'transcript', request: { sourceId } }, { kind: 'discover', request: { sourceId } }, { kind: 'pacing', request: { sourceId, cuts: [{ start: 0, end: 1 }], options: { mode: 'natural' } } }, { kind: 'speaker-focus', request: { sourceId, cuts: [{ start: 0, end: 1, focalPoint: { x: .5, y: .5 } }], mode: 'speaker' } }] });
    let status;
    for (let attempt = 0; attempt < 100; attempt++) { status = await call('get_analysis', { analysisId: started.analysisId }); if (status.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(status.status, 'completed'); assert.equal(status.results.length, 4);
    assert.equal(status.results[0].result.segments[0].text, 'été');
    assert.match(status.results[1].error, /Fixture discovery unavailable/);
    assert.equal(status.results[2].result.route, '/api/shorts/pacing');
    assert.deepEqual(status.results[2].result.body.cuts, [{ start: 0, end: 1 }]);
    assert.equal(status.results[3].result.route, '/api/speaker-focus');
    assert.equal(status.results[3].result.body.mode, 'speaker');
  } finally {
    await client.close(); await server.close(); store.close();
    await new Promise<void>(resolve => apiServer.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
});
