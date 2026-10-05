import { z } from 'zod';
import { appStoreSourceSchema, parseStoreUrl } from './app-store.js';
import { languageNameSchema, publishingLanguageSchema } from './publishing-language.js';
import type { ExportHistoryEntry, PostMetrics, PublishingPlatform, ReachAssessment } from "./types.js";

export const PLATFORM_NAMES: Record<PublishingPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
export const REACH_LABELS: Record<ReachAssessment, string> = {
  unknown: "Not assessed", normal: "No restriction observed", suspected: "Suspected reach restriction",
  confirmed: "Restriction confirmed by platform notice", resolved: "Restriction resolved",
};
export function validPublicationUrl(platform: PublishingPlatform, value: string): boolean {
  try {
    const url = new URL(value);
    const domains = platform === "youtube" ? ["youtube.com", "youtu.be"] : [`${platform}.com`];
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
/** Unknown legacy posts stay together; identified posts/accounts never overwrite each other. */
export function latestPostObservations(entry: ExportHistoryEntry): PostMetrics[] {
  const latest = new Map<string, PostMetrics>();
  for (const post of entry.measurements?.posts || []) {
    if (!post || !Object.hasOwn(PLATFORM_NAMES, post.platform) || !Number.isFinite(Date.parse(post.measuredAt))) continue;
    const key = `${post.platform}:${post.publicationId || "legacy"}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(post.measuredAt) >= Date.parse(previous.measuredAt)) latest.set(key, post);
  }
  return [...latest.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}

const text = (max: number) => z.string().trim().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u);
export const platformSchema = z.enum(['tiktok', 'instagram', 'youtube']);
export type PostPlatform = z.infer<typeof platformSchema>;
export const hashtagSchema = z.string().trim().regex(/^#[\p{L}\p{N}_]{1,80}$/u);
export const webUrlSchema = z.url().max(2000).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'Use an HTTP or HTTPS URL without credentials.');
export const promotionProfileSchema = z.object({
  id: z.uuid(), name: text(80).min(1), benefit: text(500).min(1), audience: text(300),
  features: text(2000), callToAction: text(200).min(1), storeUrl: z.union([z.literal(''), webUrlSchema]),
  language: publishingLanguageSchema, country: z.string().regex(/^[A-Z]{2}$/u),
  hashtags: z.array(hashtagSchema).max(6),
  appStore: appStoreSourceSchema.optional(),
}).strict().refine(profile => !profile.appStore || (parseStoreUrl(profile.storeUrl)?.id === profile.appStore.appId && parseStoreUrl(profile.storeUrl)?.provider === profile.appStore.provider),
  'The imported listing must match the app URL. Import the new app before saving.');
export type PromotionProfile = z.infer<typeof promotionProfileSchema>;
export const trendEvidenceSchema = z.object({
  tag: hashtagSchema, platform: platformSchema, country: z.string().regex(/^[A-Z]{2}$/u),
  sourceUrl: webUrlSchema, observedAt: z.iso.datetime({ offset: true }),
}).strict();
export type TrendEvidence = z.infer<typeof trendEvidenceSchema>;
export const postDraftSchema = z.object({
  jobId: z.string().min(1).max(100), platform: platformSchema, profileId: z.uuid().optional(),
  title: text(100).min(1), short: text(5000), long: text(5000), hashtags: z.array(hashtagSchema).max(8),
  selected: z.enum(['short', 'long']), recommended: z.enum(['short', 'long']), reason: text(800),
  provider: z.enum(['deepseek', 'hook']), generatedAt: z.iso.datetime(),
  language: languageNameSchema.optional(),
  trends: z.array(trendEvidenceSchema).max(8), trendNote: text(500),
}).strict();
export type PostDraft = z.infer<typeof postDraftSchema>;
export const tiktokSettingsSchema = z.object({
  __type: z.literal('tiktok'), title: text(90),
  privacy_level: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']),
  duet: z.boolean(), stitch: z.boolean(), comment: z.boolean(), autoAddMusic: z.literal('no'),
  brand_content_toggle: z.boolean(), brand_organic_toggle: z.boolean(), video_made_with_ai: z.boolean(),
  content_posting_method: z.literal('DIRECT_POST'),
}).strict().refine(value => !(value.brand_content_toggle && value.privacy_level === 'SELF_ONLY'), 'Paid partnerships cannot be private on TikTok.');
export const providerSettingsSchema = z.union([
  tiktokSettingsSchema,
  z.object({ __type: z.enum(['instagram', 'instagram-standalone']), post_type: z.literal('post'), is_trial_reel: z.literal(false), collaborators: z.array(z.never()).length(0) }).strict(),
  z.object({ __type: z.literal('youtube'), title: text(100).min(2), type: z.enum(['public', 'unlisted', 'private']), selfDeclaredMadeForKids: z.enum(['yes', 'no']), tags: z.array(z.object({ value: text(80), label: text(80) }).strict()).max(8) }).strict(),
]);
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export const scheduleSchema = z.object({
  requestId: z.uuid(), channelId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u),
  content: text(5000).min(1), date: z.iso.datetime({ offset: true }), timezone: text(80).refine(isTimeZone),
  settings: providerSettingsSchema,
}).strict();
export type ScheduleRequest = z.infer<typeof scheduleSchema>;
export const crossPostSchema = z.object({ requests: z.array(scheduleSchema).min(1).max(50)
  .refine(requests => new Set(requests.map(request => request.channelId)).size === requests.length, 'Choose each account only once.')
  .refine(requests => new Set(requests.map(request => request.requestId)).size === requests.length, 'Use a separate request ID for each account.') }).strict();
export interface CrossPostResult { channelId: string; publication?: Publication; message?: string }
export interface PostizChannel { id: string; name: string; identifier: string; disabled: boolean; profile?: string }
export interface Publication {
  id: string; jobId: string; exportTitle: string; request: ScheduleRequest; fingerprint: string;
  channelName: string; platform: PostPlatform; endpoint: string; createdAt: string; updatedAt: string;
  state: 'uploading' | 'submitting' | 'scheduled' | 'published' | 'failed' | 'uncertain' | 'cancelled' | 'cancelling' | 'draft';
  postId?: string; releaseUrl?: string; statusMessage?: string;
  media?: { id: string; path: string };
}
export const platformForChannel = (identifier: string): PostPlatform | undefined => identifier === 'instagram-standalone' ? 'instagram' : platformSchema.safeParse(identifier).data;
export const postContent = (draft: PostDraft, length = draft.selected) => [draft[length].trim(), draft.hashtags.join(' ')].filter(Boolean).join('\n\n');
export const contentLimit = (platform: PostPlatform) => platform === 'youtube' ? 5000 : 2200;
export function isTimeZone(value: string) { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; } }

/** Return both instants during a DST fold; no instant exists during a DST gap. */
export function scheduleInstants(local: string, timeZone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(local) || !isTimeZone(timeZone)) return [];
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall)) return [];
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const stamp = (ms: number) => { const p = Object.fromEntries(format.formatToParts(ms).map(p => [p.type, p.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  const offsets = new Set([-36, -12, 0, 12, 36].map(hours => { const ms = wall + hours * 3600000; return Date.parse(`${stamp(ms)}:00Z`) - ms; }));
  return [...offsets].map(offset => wall - offset).filter(ms => stamp(ms) === local).sort().map(ms => new Date(ms).toISOString());
}
