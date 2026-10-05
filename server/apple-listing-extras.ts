import { load } from 'cheerio';
import { appStoreSourceSchema, parseAppStoreUrl, type AppStoreSource } from '../shared/app-store.js';
import { cleanListingText as clean, fetchStorePage, listingLink } from './store-fetch.js';

/** Additional public facts that Apple's lookup API omits, especially purchase pricing. */
export function appleListingExtras(html: string, source: AppStoreSource): AppStoreSource {
  const $ = load(html), listing = parseAppStoreUrl($('link[rel="canonical"]').attr('href') || '');
  if (listing?.id !== source.appId || listing.country !== source.country) return source;
  const purchases = $('dt').filter((_, element) => $(element).text().trim() === 'In-App Purchases').first().next('dd');
  const purchaseDetails = purchases.find('li').toArray().map(element => $(element).find('span').toArray().map(span => $(span).text().trim()).filter(Boolean).join(' — ')).filter(Boolean).join('\n');
  const subtitle = clean($('h1').first().parent().find('h2, [class*="subtitle"]').first().text(), 300);
  const developer = listingLink($('a').filter((_, element) => $(element).text().trim() === 'Developer Website').first().attr('href'));
  const privacy = listingLink($('a').filter((_, element) => $(element).text().trim().toLowerCase() === 'privacy policy').first().attr('href'));
  return appStoreSourceSchema.parse({ ...source, ...(subtitle ? { subtitle } : {}),
    ...(purchases.length ? { inAppPurchases: purchases.text().trim().startsWith('Yes'), purchaseDetails: clean(purchaseDetails, 3000) || undefined } : {}),
    ...(developer ? { developerUrl: developer } : {}), ...(privacy ? { privacyUrl: privacy } : {}),
  });
}

export async function enrichAppleListing(source: AppStoreSource, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AppStoreSource> {
  try { return appleListingExtras(await fetchStorePage(source.url, 'App Store', signal, fetcher, true), source); }
  catch { signal.throwIfAborted(); return source; } // Lookup facts remain useful if the optional page is unavailable.
}
