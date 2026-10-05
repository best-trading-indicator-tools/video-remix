import { z } from 'zod';

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
const plain = (max: number) => z.string().trim().max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u);
export const appleImageSchema = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname.endsWith('.mzstatic.com');
});
export const appStoreSourceSchema = z.object({
  provider: z.literal('apple'), appId: z.string().regex(/^[1-9]\d{0,14}$/u),
  url: z.url().max(2000), country: z.string().regex(/^[A-Z]{2}$/u), checkedAt: z.iso.datetime(),
  name: plain(200).min(1), description: plain(16000).min(1), developer: plain(300), category: plain(100), version: plain(100),
  languages: z.array(plain(20)).max(100), downloadPrice: plain(100),
  rating: z.number().min(0).max(5).optional(), ratingCount: z.number().int().nonnegative().optional(),
  iconUrl: appleImageSchema.optional(), screenshots: z.array(appleImageSchema).max(8),
}).strict().refine(value => value.url === appStoreUrl(value.appId, value.country), 'The listing URL must match the app and country.');
export type AppStoreSource = z.infer<typeof appStoreSourceSchema>;
export const appStoreImportSchema = z.object({
  url: z.string().trim().min(1).max(2000).refine(value => !!parseAppStoreUrl(value), 'Paste an HTTPS App Store app link containing its id.'),
  country: z.string().regex(/^[A-Z]{2}$/u).optional(), language: plain(60).min(1).default('English'), summarize: z.boolean().default(false),
}).strict();
export type AppStoreImportRequest = z.infer<typeof appStoreImportSchema>;
export interface AppStoreImportResult {
  source: AppStoreSource;
  suggestions: { name: string; benefit: string; audience: string; features: string };
  summarized: boolean;
  note: string;
}
