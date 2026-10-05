import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { scheduleInstants, promotionProfileSchema, postContent, providerSettingsSchema, type PromotionProfile } from '../shared/publishing.js';
import { fallbackPostDraft, freshTrends, generatePostDraft } from '../server/post-copy.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import type { StoredJob } from '../server/store.js';

const profile: PromotionProfile = { id: randomUUID(), name: 'Focus app', benefit: 'Plan focused work sessions', audience: 'Students', features: 'A timer and session notes', callToAction: 'Try Focus', language: 'French', country: 'FR', storeUrl: 'https://example.com/focus', hashtags: ['#Focus'] };
const job: StoredJob = { id: 'export', sourceId: 'source', sourceName: 'clip.mp4', variant: 1, batchId: 'batch', status: 'completed', progress: 100, createdAt: new Date().toISOString(), settings: { ...DEFAULT_SETTINGS, hookText: 'Make room for focus' }, outputPath: '/unused.mp4' };

test('scheduling resolves normal wall times and forces an explicit choice for DST overlaps', () => {
  assert.deepEqual(scheduleInstants('2026-10-06T12:00', 'Europe/Paris'), ['2026-10-06T10:00:00.000Z']);
  assert.deepEqual(scheduleInstants('2026-03-29T02:30', 'Europe/Paris'), []);
  assert.deepEqual(scheduleInstants('2026-10-25T02:30', 'Europe/Paris'), ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
  assert.deepEqual(scheduleInstants('2026-10-06T12:00', 'Invalid/Zone'), []);
  assert.deepEqual(scheduleInstants('2026-02-31T12:00', 'UTC'), []);
});
test('profiles reject credentials and executable URLs, and settings cannot publish immediately or send TikTok inbox uploads', () => {
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com/app']) assert.equal(promotionProfileSchema.safeParse({ ...profile, storeUrl: url }).success, false);
  const settings = { __type: 'tiktok', title: 'Title', privacy_level: 'PUBLIC_TO_EVERYONE', duet: false, stitch: false, comment: true, autoAddMusic: 'no', brand_content_toggle: false, brand_organic_toggle: true, video_made_with_ai: false, content_posting_method: 'DIRECT_POST' };
  assert.equal(providerSettingsSchema.safeParse(settings).success, true);
  assert.equal(providerSettingsSchema.safeParse({ ...settings, content_posting_method: 'UPLOAD' }).success, false);
  assert.equal(providerSettingsSchema.safeParse({ ...settings, privacy_level: 'SELF_ONLY', brand_content_toggle: true }).success, false);
});
test('without DeepSeek the hook and app hashtags remain editable copy, without fabricated long copy or trends', async () => {
  const draft = await generatePostDraft(job, 'instagram', profile, new AbortController().signal, { aiConfigured: false, generate: async () => { throw new Error('Must not call a provider'); } });
  assert.equal(draft.short, job.settings.hookText); assert.equal(draft.long, draft.short); assert.equal(draft.provider, 'hook');
  assert.equal(postContent(draft), 'Make room for focus\n\n#Focus'); assert.deepEqual(draft.trends, []);
  assert.equal(fallbackPostDraft({ ...job, exportName: 'My export', settings: { ...DEFAULT_SETTINGS } }, 'youtube').title, 'My export');
});
test('trend evidence must be recent and match both platform and country', () => {
  const now = Date.parse('2026-10-05T12:00:00Z'), ref = { tag: '#Study', platform: 'tiktok', country: 'FR', sourceUrl: 'https://ads.tiktok.com/creative/creativeCenter/trends', observedAt: '2026-10-05T10:00:00Z' };
  assert.deepEqual(freshTrends([ref], 'tiktok', 'FR', now), [ref]);
  for (const changed of [{ country: 'US' }, { platform: 'instagram' }, { observedAt: '2026-10-03T10:00:00Z' }, { observedAt: '2026-10-06T10:00:00Z' }])
    assert.deepEqual(freshTrends([{ ...ref, ...changed }], 'tiktok', 'FR', now), []);
});
test('AI receives app facts and only this export context; a suggested tag cannot manufacture trend evidence', async () => {
  let captured: unknown;
  const draft = await generatePostDraft(job, 'tiktok', profile, new AbortController().signal, { aiConfigured: true, trends: [
    { tag: '#Study', platform: 'tiktok', country: 'FR', sourceUrl: 'https://ads.tiktok.com/creative/creativeCenter/trends', observedAt: new Date().toISOString() },
  ], generate: async input => {
    captured = input.prompt; assert.match(input.system!, /Never invent features/u);
    return { title: 'Find your focus', short: 'Plan your session. Try Focus.', long: 'Start with one task.\n\nSet a timer and keep session notes. Try Focus.', hashtags: ['#Study', '#MadeUpTrend', '#focus'], recommended: 'short', reason: 'One clear benefit needs little extra explanation.' };
  } });
  assert.equal((captured as { profile: PromotionProfile }).profile.name, profile.name);
  assert.equal(draft.provider, 'deepseek'); assert.deepEqual(draft.trends.map(item => item.tag), ['#Study']);
  assert.equal(draft.hashtags.filter(tag => tag.toLowerCase() === '#focus').length, 1);
  assert.equal(draft.selected, draft.recommended);
});
test('imported listing text grounds generated copy without implying screenshot analysis or live hashtag evidence', async () => {
  const appStore = { provider: 'apple' as const, appId: '12', url: 'https://apps.apple.com/us/app/id12', country: 'US', checkedAt: new Date().toISOString(),
    name: 'Focus', description: 'Premium timers require a subscription.', developer: '', category: '', version: '1', languages: ['EN'], downloadPrice: 'Free', screenshots: ['https://is1.mzstatic.com/image/shot.png'] };
  await generatePostDraft(job, 'tiktok', { ...profile, appStore }, new AbortController().signal, { aiConfigured: true, trends: [], generate: async input => {
    const prompt = input.prompt as { profile: { appStore: Record<string, unknown> } };
    assert.equal(prompt.profile.appStore.description, appStore.description); assert.equal(prompt.profile.appStore.sourceUrl, appStore.url);
    assert.equal(prompt.profile.appStore.retrievedAt, appStore.checkedAt); assert.equal(prompt.profile.appStore.screenshots, undefined);
    assert.match(input.system!, /free download is not evidence of a free service/u);
    return { title: 'Focus', short: 'Try Focus', long: 'Plan your sessions.', hashtags: [], recommended: 'short', reason: 'One benefit.' };
  } });
});
