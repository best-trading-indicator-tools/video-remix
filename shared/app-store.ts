import { z } from 'zod';
import { publishingLanguageSchema } from './publishing-language.js';

/** Parse public listing links only. Never fetch the supplied URL. */
export function parseAppStoreUrl(value: string): { id: string; country?: string } | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['apps.apple.com', 'itunes.apple.com'].includes(url.hostname)) return;
    const match = /^\/(?:([a-z]{2})\/)?app\/(?:[^/]+\/)?id([1-9]\d{0,14})\/?$/iu.exec(url.pathname);
    if (!match || !Number.isSafeInteger(Number(match[2]))) return;
    return { id: match[2], country: match[1]?.toUpperCase() };
  } catch { return; }
}
export const appStoreUrl = (id: string, country: string) => `https://apps.apple.com/${country.toLowerCase()}/app/id${id}`;
const packageId = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
export function parseStoreUrl(value: string): { provider: 'apple' | 'google'; id: string; country?: string } | undefined {
  const apple = parseAppStoreUrl(value);
  if (apple) return { provider: 'apple', ...apple };
  try {
    const url = new URL(value.trim()), id = url.searchParams.get('id');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== 'play.google.com' ||
      !/^\/store\/apps\/details(?:\/[^/]+)?\/?$/u.test(url.pathname) || !id || id.length > 200 || !packageId.test(id) || url.searchParams.getAll('id').length !== 1) return;
    const country = url.searchParams.get('gl')?.toUpperCase();
    return { provider: 'google', id, country: country && /^[A-Z]{2}$/u.test(country) ? country : undefined };
  } catch { return; }
}
export const googlePlayUrl = (id: string, country: string) => `https://play.google.com/store/apps/details?${new URLSearchParams({ id, gl: country, hl: 'en' })}`;
export const storeName = (provider: 'apple' | 'google') => provider === 'apple' ? 'App Store' : 'Google Play';
const plain = (max: number) => z.string().trim().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u);
export const appleImageSchema = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname.endsWith('.mzstatic.com');
});
export const googleImageSchema = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['play-lh.googleusercontent.com', 'lh3.googleusercontent.com', 'lh4.googleusercontent.com', 'lh5.googleusercontent.com', 'lh6.googleusercontent.com'].includes(url.hostname);
});
const publicLink = z.url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; });
export const appStoreSourceSchema = z.object({
  provider: z.enum(['apple', 'google']), appId: z.string().min(1).max(200),
  url: z.url().max(2000), country: z.string().regex(/^[A-Z]{2}$/u), checkedAt: z.iso.datetime(),
  name: plain(200).min(1), description: plain(16000).min(1), developer: plain(300), category: plain(100), version: plain(100),
  languages: z.array(plain(20)).max(100), downloadPrice: plain(100),
  rating: z.number().min(0).max(5).optional(), ratingCount: z.number().int().nonnegative().optional(),
  iconUrl: z.union([appleImageSchema, googleImageSchema]).optional(), screenshots: z.array(z.union([appleImageSchema, googleImageSchema])).max(40),
  subtitle: plain(300).optional(), releaseNotes: plain(8000).optional(), contentRating: plain(100).optional(),
  minimumOsVersion: plain(100).optional(), updatedAt: plain(100).optional(), downloads: plain(100).optional(),
  developerUrl: publicLink.optional(), privacyUrl: publicLink.optional(),
  inAppPurchases: z.boolean().optional(), purchaseDetails: plain(3000).optional(), containsAds: z.boolean().optional(),
}).strict().refine(value => {
  const app = parseStoreUrl(value.url);
  const imageSchema = value.provider === 'apple' ? appleImageSchema : googleImageSchema;
  return app?.id === value.appId && app.provider === value.provider &&
    value.url === (value.provider === 'apple' ? appStoreUrl(value.appId, value.country) : googlePlayUrl(value.appId, value.country)) &&
    (!value.iconUrl || imageSchema.safeParse(value.iconUrl).success) && value.screenshots.every(image => imageSchema.safeParse(image).success);
}, 'The listing URL, images, app and country must match their store.');
export type AppStoreSource = z.infer<typeof appStoreSourceSchema>;
export const appStoreImportSchema = z.object({
  url: z.string().trim().min(1).max(2000).refine(value => !!parseStoreUrl(value), 'Paste an App Store or Google Play app link.'),
  country: z.string().regex(/^[A-Z]{2}$/u).optional(), language: publishingLanguageSchema, summarize: z.boolean().default(false),
}).strict();
export type AppStoreImportRequest = z.infer<typeof appStoreImportSchema>;
export interface AppStoreImportResult {
  source: AppStoreSource;
  suggestions: { name: string; benefit: string; audience: string; features: string; callToAction?: string };
  summarized: boolean;
  note: string;
}
