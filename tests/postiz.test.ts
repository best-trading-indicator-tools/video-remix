import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostizClient, PostizError } from '../server/postiz.js';
import type { ScheduleRequest } from '../shared/publishing.js';
const config = { endpoint: 'https://api.postiz.com/public/v1', dashboard: 'https://platform.postiz.com', apiKey: 'private-fixture-key' };
const request: ScheduleRequest = { requestId: randomUUID(), channelId: 'channel', content: 'Try this app', date: '2027-01-01T11:00:00Z', timezone: 'Europe/Paris', settings: { __type: 'youtube', title: 'Try this app', type: 'public', selfDeclaredMadeForKids: 'no', tags: [] } };
test('Postiz receives an uploaded media ID, raw authorization, future UTC date and only the selected channel', async () => {
  const api = new PostizClient(config, async (url, init) => {
    assert.equal(url, `${config.endpoint}/posts`); assert.equal((init!.headers as Record<string, string>).Authorization, config.apiKey);
    assert.equal(init!.redirect, 'error');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.type, 'schedule'); assert.equal(body.date, request.date); assert.equal(body.posts.length, 1);
    assert.deepEqual(body.posts[0].value[0].image, [{ id: 'video', path: 'https://uploads.postiz.com/export.mp4' }]);
    assert.deepEqual(body.posts[0].settings, request.settings); assert.equal(body.posts[0].integration.id, 'channel');
    return Response.json([{ postId: 'post', integration: 'channel' }]);
  });
  assert.equal(await api.schedule(request, { id: 'video', path: 'https://uploads.postiz.com/export.mp4' }), 'post');
});
test('lost create responses are uncertain and never automatically retried; rejected input is a known failure', async () => {
  for (const mode of ['network', 'bad-json', 'missing-id', 'server-error', 'validation'] as const) {
    let calls = 0;
    const api = new PostizClient(config, async () => {
      calls++;
      if (mode === 'network') throw new Error(`upstream error containing ${config.apiKey}`);
      if (mode === 'bad-json') return new Response('bad');
      if (mode === 'missing-id') return Response.json([]);
      return new Response(config.apiKey, { status: mode === 'validation' ? 400 : 500 });
    });
    await assert.rejects(api.schedule(request, { id: 'id', path: 'https://uploads.postiz.com/video.mp4' }), error => {
      assert.ok(error instanceof PostizError); assert.equal(error.uncertain, mode !== 'validation'); assert.ok(!error.message.includes(config.apiKey)); return true;
    });
    assert.equal(calls, 1);
  }
});
test('channel discovery excludes unsupported providers and preserves disconnected accounts for clear feedback', async () => {
  const api = new PostizClient(config, async () => Response.json([{ id: 'a', name: 'A', identifier: 'instagram-standalone', disabled: false, profile: null }, { id: 'b', name: 'B', identifier: 'tiktok', disabled: true }, { id: 'c', name: 'C', identifier: 'x' }]));
  assert.deepEqual((await api.channels()).map(item => [item.id, item.disabled]), [['a', false], ['b', true]]);
});
