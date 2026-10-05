export class AppStoreError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}
export const cleanListingText = (value: unknown, max: number) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, max) : '';
export function listingLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return; }
}

/** The caller supplies a canonical store URL, never a user-supplied fetch target. */
export async function fetchStorePage(url: string, store: string, signal: AbortSignal, fetcher: typeof fetch = fetch, appleRedirects = false): Promise<string> {
  signal.throwIfAborted();
  try {
    const options: RequestInit = { redirect: appleRedirects ? 'manual' : 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } };
    let response = await fetcher(url, options);
    for (let hops = 0; appleRedirects && response.status >= 300 && response.status < 400 && hops < 2; hops++) {
      const next = new URL(response.headers.get('location') || '', url), original = parseStoreUrl(url), redirected = parseStoreUrl(next.href);
      await response.body?.cancel();
      if (!original || original.provider !== 'apple' || redirected?.provider !== 'apple' || redirected.id !== original.id || redirected.country !== original.country)
        throw new AppStoreError('The App Store returned an unexpected redirect.');
      response = await fetcher(next, options);
    }
    if (response.status === 404) throw new AppStoreError(`This app was not found in this ${store} country. Check the link or choose another country.`, 404);
    if (response.status === 429) throw new AppStoreError(`${store} is receiving too many requests. Wait a minute, then retry.`, 429);
    if (!response.ok || !response.body) throw new AppStoreError(`${store} could not return this listing. Retry shortly.`);
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 4_000_000) throw new AppStoreError(`${store} returned an unexpectedly large listing.`);
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppStoreError) throw error;
    throw new AppStoreError(`${store} could not be reached. Retry, or enter the app details manually.`);
  }
}
import { parseStoreUrl } from '../shared/app-store.js';
