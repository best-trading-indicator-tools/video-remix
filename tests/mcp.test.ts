import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRemixMcpServer } from '../server/mcp/server.js';
import { RemixMcpService } from '../server/mcp/service.js';
import { DraftStore, type EditDraft } from '../server/mcp/drafts.js';
import { RemixApi } from '../server/mcp/api.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

test('local MCP tools preserve per-video drafts, validate batches and never duplicate a render', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remix-mcp-'));
  const ids = [randomUUID(), randomUUID(), randomUUID()], assetId = randomUUID();
  const sources = ids.map((id, i) => ({ id, name: `Video ${i + 1}.mp4`, duration: 10 + i * 10, width: 640, height: 360, hasAudio: false }));
  const jobs: any[] = [], requests: { route: string; body: any }[] = [];
  let rejectRender = 0, ambiguous = false, clarify = false, promptFootage = false;
  const apiServer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const route = req.url!; requests.push({ route, body });
    res.setHeader('Content-Type', 'application/json');
    let result: unknown;
    if (route === '/api/sources') result = { sources };
    else if (route === '/api/health') result = { ok: true, ffmpeg: true, ffprobe: true, maxFileSize: 500_000_000 };
    else if (route === '/api/auto/capabilities') result = { intelligence: true };
    else if (route === '/api/broll') result = { assets: [{ id: assetId, name: 'ending.mp4', duration: 3, hasAudio: false, tags: ['sunset'] }] };
    else if (route.endsWith('/auto-prompt')) result = clarify && route.includes(ids[1]!) ? { options: body.options, variants: 1, summary: [], clarification: 'Choose the text.' }
      : { options: { ...body.options, captionStyle: { fontSize: 24, bottomPercent: 20 },
        ...(promptFootage ? { ownFootage: [{ id: randomUUID(), assetId, mode: 'insert', appendToEnd: true, at: 0, start: 0, end: 3, audio: 'clip', fit: 'contain' }] } : {}),
      }, variants: body.variants, summary: ['Updated settings.'] };
    else if (req.method === 'POST' && ['/api/auto/jobs', '/api/jobs'].includes(route)) {
      if (rejectRender) { res.statusCode = rejectRender; result = { error: 'Fixture rejected this batch.' }; }
      else {
        const batchId = randomUUID();
        const batch = body.items.map((item: any) => ({ id: randomUUID(), batchId, sourceId: item.sourceId, sourceName: 'Fixture', status: 'queued', progress: 0, settings: item.settings ?? DEFAULT_SETTINGS, auto: item.options }));
        jobs.push(...batch);
        if (ambiguous) { req.socket.destroy(); return; }
        result = { batchId, jobs: batch };
      }
    } else if (route === '/api/jobs') result = { jobs };
    else { res.statusCode = 404; result = { error: 'Unsupported fixture route' }; }
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  const api = new RemixApi(`http://127.0.0.1:${(apiServer.address() as import('node:net').AddressInfo).port}`);
  const filename = path.join(directory, 'drafts.sqlite'), store = new DraftStore(filename);
  const secondStore = new DraftStore(filename);
  const service = new RemixMcpService(api, store), server = createRemixMcpServer(service);
  const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = response.content.find(item => item.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Missing tool text');
    if (response.isError) throw new Error(text.text);
    return JSON.parse(text.text);
  };
  let draft: EditDraft;
  try {
    await t.test('protocol advertises typed workflows and guards explicit publishing/deletion without generic HTTP or secrets', async () => {
      const { tools } = await client.listTools();
      assert.ok(tools.some(tool => tool.name === 'create_draft' && tool.inputSchema.properties?.sourceIds));
      assert.equal(tools.find(tool => tool.name === 'list_videos')?.annotations?.readOnlyHint, true);
      assert.equal(tools.find(tool => tool.name === 'render_draft')?.annotations?.idempotentHint, true);
      assert.ok(!tools.some(tool => /api_key|request|shell|http_request/u.test(tool.name)));
      for (const name of ['schedule_posts', 'delete_exports', 'remove_media', 'cancel_publication']) {
        const tool = tools.find(tool => tool.name === name)!;
        assert.equal(tool.annotations?.destructiveHint, true);
        assert.ok(tool.inputSchema.required?.includes('confirm'));
      }
      assert.equal((await call('list_videos', { search: 'Video 2' })).videos[0].id, ids[1]);
      const tagged = await call('list_footage', { search: 'SUNSET' });
      assert.equal(tagged.assets[0].id, assetId); assert.deepEqual(tagged.assets[0].tags, ['sunset']);
      assert.equal((await call('get_status')).health.ok, true);
    });
    await t.test('drafts start without paid/generated features and do not create exports', async () => {
      const result = await call('create_draft', { sourceIds: ids, title: 'Three videos' }); draft = result.draft;
      assert.equal(jobs.length, 0); assert.equal(result.totalExports, 3);
      for (const item of draft.items) {
        assert.equal(item.options?.durationMode, 'full'); assert.equal(item.options?.captions, 'keep');
        assert.equal(item.options?.narration, false); assert.equal(item.options?.editorialMode, 'off');
      }
      assert.deepEqual(secondStore.get(draft.id), draft);
    });
    await t.test('sparse selected-video changes preserve each footer, captions, dimensions and unselected settings', async () => {
      draft = (await call('update_draft', { draftId: draft.id, revision: draft.revision, sourceIds: [ids[0]], auto: {
        aspect: '1:1', blackBands: { enabled: true, bottomText: 'Keep footer', bottomStyle: { color: '#00ff00', fontPercent: 8 } }, captionStyle: { color: '#ffff00' },
      } })).draft;
      const original = structuredClone(draft);
      draft = (await call('update_draft', { draftId: draft.id, revision: draft.revision, sourceIds: ids.slice(0, 2), auto: {
        blackBands: { enabled: true, topText: 'BPC157', topStyle: { cyrillic: true, color: '#ffffff', fontPercent: 5.4 } },
      } })).draft;
      assert.equal(draft.items[0]?.options?.aspect, '1:1');
      assert.equal(draft.items[0]?.options?.blackBands?.bottomText, 'Keep footer');
      assert.equal(draft.items[0]?.options?.blackBands?.bottomStyle?.fontPercent, 8);
      assert.deepEqual(draft.items[0]?.options?.captionStyle, original.items[0]?.options?.captionStyle);
      assert.deepEqual(draft.items[2], original.items[2]);
      assert.equal(draft.items[1]?.options?.blackBands?.topStyle?.cyrillic, true);
      await assert.rejects(call('update_draft', { draftId: draft.id, revision: original.revision, auto: { aspect: '9:16' } }), /changed/);
    });
    await t.test('speed and flip are discoverable independent bulk settings with durable Undo in both modes', async () => {
      const catalog = await call('get_editing_catalog'); assert.deepEqual(catalog.playback.speed, { min: .5, max: 2, default: 1 });
      for (const mode of ['auto', 'manual']) {
        let value = (await call('create_draft', { sourceIds: ids, mode, [mode]: { speed: .8, mirror: false, aspect: '1:1' } })).draft;
        const original = structuredClone(value);
        const review = await call('update_draft', { draftId: value.id, revision: value.revision, sourceIds: ids.slice(0, 2), [mode]: { speed: 1.5 } });
        value = review.draft;
        const settings = (item: any) => item.options ?? item.settings;
        assert.deepEqual(value.items.map((item: any) => settings(item).speed), [1.5, 1.5, .8]);
        assert.ok(value.items.every((item: any) => settings(item).mirror === false && settings(item).aspect === '1:1'));
        assert.match(review.summary[0].description.join(' '), /Playback speed: 1.5/);
        value = (await call('update_draft', { draftId: value.id, revision: value.revision, [mode]: { mirror: true } })).draft;
        assert.deepEqual(value.items.map((item: any) => settings(item).speed), [1.5, 1.5, .8]);
        assert.ok(value.items.every((item: any) => settings(item).mirror));
        const regions = [{ x: .1, y: .7, width: .8, height: .15 }];
        value = (await call('update_draft', { draftId: value.id, revision: value.revision, sourceIds: [ids[0]], [mode]: { embeddedTextRegions: regions } })).draft;
        const untouched = structuredClone(value.items[2]);
        value = (await call('update_draft', { draftId: value.id, revision: value.revision, sourceIds: ids.slice(0, 2), [mode]: { preserveEmbeddedText: true } })).draft;
        assert.deepEqual(settings(value.items[0]).embeddedTextRegions, regions);
        assert.equal(settings(value.items[1]).embeddedTextRegions, undefined);
        assert.deepEqual(value.items[2], untouched);
        assert.ok(value.items.slice(0, 2).every((item: any) => settings(item).preserveEmbeddedText));
        await assert.rejects(call('update_draft', { draftId: value.id, revision: value.revision, [mode]: { embeddedTextRegions: [{ x: .9, y: .9, width: .5, height: .2 }] } }));
        assert.deepEqual(secondStore.get(value.id), value);
        await assert.rejects(call('update_draft', { draftId: value.id, revision: value.revision, [mode]: { speed: 2.1 } }));
        const restored = (await call('restore_draft', { draftId: value.id, revision: value.revision, targetRevision: original.revision })).draft;
        assert.deepEqual(restored.items, original.items);
      }
    });
    await t.test('invalid values and missing IDs reject the whole draft without touching its revision', async () => {
      const before = structuredClone(draft);
      for (const args of [
        { auto: { blackBands: { topPercent: 40, bottomPercent: 40 } } },
        { auto: { captionStyle: { fontSize: 99 } } }, { auto: { unsupported: true } },
        { sourceIds: [randomUUID()], auto: { aspect: '1:1' } }, { auto: {}, variants: 2 },
      ]) await assert.rejects(call('update_draft', { draftId: draft.id, revision: draft.revision, ...args }));
      assert.deepEqual(store.get(draft.id), before); assert.equal(jobs.length, 0);
    });
    await t.test('ending footage appends in full, retains previous clips and binds each placement to its source', async () => {
      draft = (await call('append_footage', { draftId: draft.id, revision: draft.revision, assetId })).draft;
      draft = (await call('append_footage', { draftId: draft.id, revision: draft.revision, assetId, sourceIds: [ids[0]], audio: 'mute' })).draft;
      for (const item of draft.items) {
        assert.equal(item.options?.ownFootageSourceId, item.sourceId);
        assert.equal(item.options?.ownFootage?.[0]?.end, 3); assert.equal(item.options?.ownFootage?.[0]?.appendToEnd, true);
      }
      assert.equal(draft.items[0]?.options?.ownFootage?.length, 2);
      assert.equal(draft.items[1]?.options?.ownFootage?.length, 1);
    });
    await t.test('DeepSeek clarification leaves all draft videos unchanged', async () => {
      clarify = true;
      const before = structuredClone(draft);
      const response = await call('apply_prompt_to_draft', { draftId: draft.id, revision: draft.revision, prompt: 'Make captions larger' });
      assert.equal(response.applied, false); assert.match(response.clarification, /Choose the text/);
      assert.deepEqual(store.get(draft.id), before);
      clarify = false;
      draft = (await call('apply_prompt_to_draft', { draftId: draft.id, revision: draft.revision, prompt: 'Make captions larger' })).draft;
      assert.ok(draft.items.every(item => item.options?.captionStyle?.fontSize === 24));
    });
    await t.test('typed batch text edits preserve individual words/styles, support Undo and persist finishing presets', async () => {
      const before = structuredClone(draft);
      draft = (await call('update_draft', { draftId: draft.id, revision: draft.revision, auto: { textEdits: [{ action: 'add', text: 'Shared title', design: 'bold' }], captionCorrections: [{ find: 'acme', replace: 'ACME' }] } })).draft;
      const titles = draft.items.map(item => item.options!.textOverlays![0]!);
      assert.equal(new Set(titles.map(title => title.id)).size, 3);
      const unchecked = structuredClone(draft.items[2]);
      draft = (await call('update_draft', { draftId: draft.id, revision: draft.revision, sourceIds: ids.slice(0, 2), auto: { textEdits: [{ action: 'update', index: 0, style: { fontSize: 4, animation: 'slide' } }], captionStyle: { fontSize: 4.5 }, blackBands: { topStyle: { fontPercent: 1 } } } })).draft;
      assert.ok(draft.items.slice(0, 2).every(item => item.options?.textOverlays?.[0]?.style.fontSize === 4 && item.options?.captionStyle?.fontSize === 4.5 && item.options?.blackBands?.topStyle?.fontPercent === 1));
      assert.deepEqual(draft.items[2], unchecked);
      assert.deepEqual(draft.items[2]?.options?.textOverlays?.[0], titles[2]);
      const updatedRevision = draft.revision;
      const preset = await call('save_finishing_preset', { draftId: draft.id, sourceId: ids[0], name: 'Caption fixes' });
      assert.equal(preset.settings.captionCorrections[0].replace, 'ACME');
      assert.equal('textOverlays' in preset.settings, false);
      assert.equal((await call('list_finishing_presets')).presets.length, 1);
      assert.deepEqual(secondStore.presets()[0], preset);
      assert.ok((await call('list_draft_history', { draftId: draft.id })).revisions.some((item: any) => item.revision === before.revision));
      draft = (await call('restore_draft', { draftId: draft.id, revision: draft.revision, targetRevision: before.revision })).draft;
      assert.deepEqual(draft.items, before.items);
      draft = (await call('restore_draft', { draftId: draft.id, revision: draft.revision, targetRevision: updatedRevision })).draft;
      assert.equal(draft.items[0]?.options?.textOverlays?.[0]?.style.fontSize, 4);
      assert.deepEqual(secondStore.get(draft.id), draft);
    });
    await t.test('render submits one atomic batch and concurrent/repeated calls cannot enqueue duplicates', async () => {
      const inputs = { draftId: draft.id, revision: draft.revision };
      const results = await Promise.allSettled([call('render_draft', inputs), call('render_draft', inputs)]);
      assert.ok(results.some(result => result.status === 'fulfilled'));
      assert.equal(jobs.length, 3);
      const receipt = await call('render_draft', inputs);
      assert.equal(receipt.alreadySubmitted, true); assert.equal(receipt.jobIds.length, 3);
      assert.equal(requests.filter(item => item.route === '/api/auto/jobs').length, 1);
      assert.equal((await call('get_export', { jobId: receipt.jobIds[0] })).status, 'queued');
      assert.equal((await call('list_exports', { batchId: receipt.batchId })).total, 3);
      assert.equal(secondStore.get(draft.id).status, 'submitted');
    });
    await t.test('new footage proposed by a prompt gets bound to each source and survives batch validation', async () => {
      promptFootage = true;
      try {
        let prompted = (await call('create_draft', { sourceIds: ids })).draft as EditDraft;
        prompted = (await call('apply_prompt_to_draft', { draftId: prompted.id, revision: prompted.revision, prompt: 'Append the ending clip' })).draft;
        await call('render_draft', { draftId: prompted.id, revision: prompted.revision });
        const sent = requests.findLast(item => item.route === '/api/auto/jobs' && item.body);
        for (const item of sent!.body.items) {
          assert.equal(item.options.ownFootageSourceId, item.sourceId);
          assert.equal(item.options.ownFootage[0].assetId, assetId);
        }
      } finally { promptFootage = false; }
    });
    await t.test('a lost render response blocks replay while a definitive 4xx rejection remains editable', async () => {
      let copy = (await call('clone_draft', { draftId: draft.id })).draft;
      rejectRender = 400;
      await assert.rejects(call('render_draft', { draftId: copy.id, revision: copy.revision }), /rejected/);
      copy = store.get(copy.id); assert.equal(copy.status, 'ready');
      rejectRender = 0; ambiguous = true;
      await assert.rejects(call('render_draft', { draftId: copy.id, revision: copy.revision }), /Cannot reach/);
      assert.equal(store.get(copy.id).status, 'submitting');
      const count = jobs.length;
      await assert.rejects(call('render_draft', { draftId: copy.id, revision: copy.revision }), /already has a render submission/);
      assert.equal(jobs.length, count); ambiguous = false;
    });
    await t.test('Manual batches use the existing renderer and reject invalid cuts before submission', async () => {
      const manual = (await call('create_draft', { mode: 'manual', sourceIds: [ids[0]], manual: { trimStart: 1, trimEnd: 4, speed: 1.5 } })).draft;
      await assert.rejects(call('update_draft', { draftId: manual.id, revision: manual.revision, manual: { trimEnd: 100 } }), /source duration/);
      await call('render_draft', { draftId: manual.id, revision: manual.revision });
      const sent = requests.findLast(item => item.route === '/api/jobs' && item.body);
      assert.equal(sent?.body.items[0].settings.speed, 1.5);
    });
  } finally {
    await client.close(); await server.close(); store.close(); secondStore.close();
    await new Promise<void>(resolve => apiServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP backend address accepts loopback only, without credentials, paths or redirects', async t => {
  for (const input of ['https://example.com', 'http://192.168.1.2:8787', 'http://127.0.0.1:8787/api', 'http://user:pass@localhost:8787', 'http://localhost:8787/?target=remote'])
    assert.throws(() => new RemixApi(input), /local HTTP origin/);
  assert.equal(new RemixApi('http://localhost:8787').baseUrl, 'http://localhost:8787');
  assert.equal(new RemixApi('http://[::1]:8787').baseUrl, 'http://[::1]:8787');
  let redirects: RequestRedirect | undefined;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { redirects = init?.redirect; throw new Error('redirect'); });
  await assert.rejects(new RemixApi().request('/api/health'), /Cannot reach/);
  assert.equal(redirects, 'error');
});
