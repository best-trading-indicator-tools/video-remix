import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { platformForChannel, type PostizChannel, type ScheduleRequest } from '../shared/publishing.js';

export class PostizError extends Error {
  constructor(message: string, public status = 502, public uncertain = false) { super(message); }
}
export function postizConfiguration() {
  const endpoint = (process.env.POSTIZ_API_URL?.trim() || 'https://api.postiz.com/public/v1').replace(/\/+$/u, '');
  const url = new URL(endpoint);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash)
    throw new PostizError('Configure a valid Postiz API URL. Use HTTPS, or HTTP on localhost.', 503);
  const dashboard = process.env.POSTIZ_WEB_URL?.trim() || (url.hostname === 'api.postiz.com' ? 'https://platform.postiz.com' : url.origin);
  const web = new URL(dashboard);
  if (!['http:', 'https:'].includes(web.protocol) || web.username || web.password) throw new PostizError('Configure a valid Postiz web URL without credentials.', 503);
  return { endpoint, dashboard, apiKey: process.env.POSTIZ_API_KEY?.trim() || '' };
}
const channelSchema = z.object({ id: z.string(), name: z.string(), identifier: z.string(), disabled: z.boolean().optional().default(false), profile: z.string().nullish() });
const mediaSchema = z.object({ id: z.string().min(1).max(200), path: z.url().max(3000).refine(url => /^https?:\/\//u.test(url)) });
export class PostizClient {
  constructor(readonly config = postizConfiguration(), private fetcher: typeof fetch = fetch) {}
  async request(route: string, init: RequestInit = {}, timeoutMs = 30000): Promise<unknown> {
    if (!this.config.apiKey) throw new PostizError('Add a Postiz API key to the server configuration.', 503);
    const creating = init.method === 'POST' && route === '/posts';
    let response: Response;
    try { response = await this.fetcher(`${this.config.endpoint}${route}`, { ...init, redirect: 'error',
      headers: { ...init.headers, Authorization: this.config.apiKey }, signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new PostizError(creating ? 'Postiz did not confirm whether the post was scheduled. Refresh its status before trying again.' : 'Could not reach Postiz. Check the connection and try again.', 502, creating); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const message = response.status === 401 || response.status === 403 ? 'Postiz rejected access. Check the API key and account permissions.'
        : response.status === 429 ? 'Postiz rate limit reached. Wait before trying again.'
          : response.status === 413 ? 'Postiz rejected the video size. Export a smaller video.'
            : `Postiz returned ${response.status}. Check the channel settings and Postiz account.`;
      throw new PostizError(message, response.status === 404 ? 404 : 502, creating && (response.status >= 500 || response.status === 408));
    }
    if (init.method === 'DELETE') { void response.body?.cancel().catch(() => {}); return {}; }
    try {
      const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw new Error('Large response'); chunks.push(value); } }
      finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new PostizError('Postiz returned an unreadable response. Refresh the post status before retrying.', 502, creating); }
  }
  async channels(): Promise<PostizChannel[]> {
    const parsed = z.array(channelSchema).safeParse(await this.request('/integrations'));
    if (!parsed.success) throw new PostizError('Postiz returned an invalid channel list.');
    return parsed.data.filter(item => platformForChannel(item.identifier)).map(item => ({ ...item, profile: item.profile ?? undefined }));
  }
  async settings(id: string) {
    const parsed = z.object({ output: z.object({ maxLength: z.number().positive().optional(), rules: z.string().optional() }) }).safeParse(await this.request(`/integration-settings/${encodeURIComponent(id)}`));
    if (!parsed.success) throw new PostizError('Postiz returned invalid channel settings.');
    return parsed.data.output;
  }
  async upload(file: string) {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > 2 * 1024 ** 3) throw new PostizError('Choose an available MP4 export under 2 GB.', 400);
    const form = new FormData(); form.set('file', await openAsBlob(file, { type: 'video/mp4' }), 'remix.mp4');
    const parsed = mediaSchema.safeParse(await this.request('/upload', { method: 'POST', body: form }, 10 * 60 * 1000));
    if (!parsed.success) throw new PostizError('Postiz did not return a usable uploaded video.');
    return parsed.data;
  }
  async schedule(request: ScheduleRequest, media: { id: string; path: string }) {
    const response = await this.request('/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      type: 'schedule', date: request.date, shortLink: false, tags: [],
      posts: [{ integration: { id: request.channelId }, value: [{ content: request.content, image: [media] }], settings: request.settings }],
    }) });
    const parsed = z.array(z.object({ postId: z.string().min(1).max(200), integration: z.string() })).safeParse(response);
    const post = parsed.success ? parsed.data.find(item => item.integration === request.channelId) : undefined;
    if (!post) throw new PostizError('Postiz did not confirm the scheduled post ID. Refresh its status before retrying.', 502, true);
    return post.postId;
  }
  async posts(date: string) {
    const ms = Date.parse(date); const query = new URLSearchParams({ startDate: new Date(ms - 24 * 3600000).toISOString(), endDate: new Date(ms + 24 * 3600000).toISOString() });
    const parsed = z.object({ posts: z.array(z.object({ id: z.string(), content: z.string().optional(), publishDate: z.string(), state: z.enum(['QUEUE', 'PUBLISHED', 'ERROR', 'DRAFT']),
      releaseURL: z.string().nullish(), error: z.string().nullish(), integration: z.object({ id: z.string() }) })) }).safeParse(await this.request(`/posts?${query}`));
    if (!parsed.success) throw new PostizError('Postiz returned an invalid post list.');
    return parsed.data.posts;
  }
  async cancel(postId: string) { await this.request(`/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' }); }
}
