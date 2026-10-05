import { load } from 'cheerio';
import { z } from 'zod';
import { appStoreSourceSchema, googleImageSchema, googlePlayUrl, parseStoreUrl, type AppStoreSource } from '../shared/app-store.js';
import { AppStoreError, cleanListingText as clean, fetchStorePage } from './store-fetch.js';

const jsonListing = z.object({
  '@type': z.literal('SoftwareApplication'), url: z.string(), name: z.string(), description: z.string().optional(),
  image: z.string().optional(), applicationCategory: z.string().optional(), contentRating: z.string().optional(),
  softwareVersion: z.string().optional(), dateModified: z.string().optional(),
  author: z.object({ name: z.string(), url: z.string().optional() }).optional(),
  aggregateRating: z.object({ ratingValue: z.coerce.number(), ratingCount: z.coerce.number() }).optional(),
  offers: z.union([z.object({ price: z.coerce.number(), priceCurrency: z.string().optional() }),
    z.array(z.object({ price: z.coerce.number(), priceCurrency: z.string().optional() }))]).optional(),
});

export function parseGooglePlayListing(html: string, id: string, country: string): AppStoreSource {
  const $ = load(html);
  const records = $('script[type="application/ld+json"]').toArray().flatMap(element => {
    try { const data = JSON.parse($(element).text()); return Array.isArray(data) ? data : data?.['@graph'] || [data]; } catch { return []; }
  });
  const listing = records.map(record => jsonListing.safeParse(record)).find(result => result.success &&
    parseStoreUrl(result.data.url)?.provider === 'google' && parseStoreUrl(result.data.url)?.id === id);
  if (!listing?.success) throw new AppStoreError('Google Play did not return this app’s listing. Check the link and target country, then retry.');
  const record = listing.data;
  const descriptionElement = $('[data-g-id="description"]').first().clone();
  descriptionElement.find('br').replaceWith('\n'); descriptionElement.find('p, li').append('\n');
  const description = clean(descriptionElement.text(), 16000);
  if (!description || !record.name.trim()) throw new AppStoreError('Google Play did not return a full app description. Retry, or enter the app details manually.');
  const icon = googleImageSchema.safeParse(record.image);
  const screenshots = [...new Set($('img[data-screenshot-index]').toArray().flatMap(element => {
    const image = googleImageSchema.safeParse($(element).attr('src')); return image.success ? [image.data] : [];
  }))].slice(0, 40);
  const offer = Array.isArray(record.offers) ? record.offers[0] : record.offers;
  const textAfter = (label: string) => clean($('div').filter((_, element) => $(element).children().length === 0 && $(element).text().trim() === label).first().next().text(), 100);
  const downloadsLabel = $('div').filter((_, element) => $(element).children().length === 0 && $(element).text().trim() === 'Downloads').first();
  const hasBadge = (label: string) => $('span').toArray().some(element => $(element).children().length === 0 && $(element).text().trim() === label);
  const link = (label: string) => {
    const candidate = $('a').filter((_, element) => {
      const anchor = $(element).clone(); anchor.find('i, svg').remove();
      return anchor.text().trim().toLowerCase() === label && !/^(?:https:\/\/)?(?:policies|support)\.google\.com\//u.test(anchor.attr('href') || '');
    }).first().attr('href');
    try { const url = new URL(candidate || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return; }
  };
  const source = appStoreSourceSchema.safeParse({ provider: 'google', appId: id, country, url: googlePlayUrl(id, country), checkedAt: new Date().toISOString(),
    name: clean(record.name, 200), description, subtitle: clean(record.description, 300) || undefined,
    developer: clean(record.author?.name, 300), category: clean(record.applicationCategory, 100), version: clean(record.softwareVersion, 100), languages: [],
    downloadPrice: offer ? (offer.price === 0 ? 'Free' : `${offer.price} ${clean(offer.priceCurrency, 20)}`.trim()) : '',
    rating: record.aggregateRating?.ratingValue, ratingCount: record.aggregateRating?.ratingCount,
    iconUrl: icon.success ? icon.data : undefined, screenshots, contentRating: clean(record.contentRating, 100) || undefined,
    updatedAt: clean(record.dateModified, 100) || textAfter('Updated on') || undefined,
    downloads: clean(downloadsLabel.prev().text(), 100) || undefined,
    inAppPurchases: hasBadge('In-app purchases') ? true : undefined, containsAds: hasBadge('Contains ads') ? true : undefined,
    developerUrl: link('website'), privacyUrl: link('privacy policy'),
  });
  if (!source.success) throw new AppStoreError('Google Play returned incomplete app details. Retry, or enter the app details manually.');
  return source.data;
}

export async function fetchGooglePlayListing(url: string, country: string | undefined, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AppStoreSource> {
  const app = parseStoreUrl(url);
  if (app?.provider !== 'google') throw new AppStoreError('Paste a Google Play app link.', 400);
  const market = country ?? app.country ?? 'US';
  return parseGooglePlayListing(await fetchStorePage(googlePlayUrl(app.id, market), 'Google Play', signal, fetcher), app.id, market);
}
