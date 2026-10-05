import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseStoreUrl, googlePlayUrl, appStoreImportSchema } from '../shared/app-store.js';
import { promotionProfileSchema } from '../shared/publishing.js';
import { fetchGooglePlayListing, parseGooglePlayListing } from '../server/google-play.js';
import { importAppStoreProfile } from '../server/app-store.js';
import { fetchStorePage } from '../server/store-fetch.js';
import { appleListingExtras, enrichAppleListing } from '../server/apple-listing-extras.js';

const url = 'https://play.google.com/store/apps/details?id=com.example.journal&gl=FR&hl=fr&utm_source=campaign';
const image = 'https://play-lh.googleusercontent.com/app-icon';
const record = { '@type': 'SoftwareApplication', name: 'Dog & Me', url, description: 'A journal for dog owners.', image,
  applicationCategory: 'LIFESTYLE', contentRating: 'Everyone', author: { name: 'Example' },
  aggregateRating: { ratingValue: '4.7', ratingCount: '123' }, offers: [{ price: '0', priceCurrency: 'EUR' }] };
const html = (data: unknown = record) => `<script>throw new Error('Never execute listing scripts')</script>
  <script type="application/ld+json">${JSON.stringify(data)}</script>
  <div data-g-id="description">A journal for dog owners.<br><br>Track walks &amp; observations.<p>Pro reminders require a subscription.</p></div>
  <div><div>Updated on</div><div>Oct 4, 2026</div></div><div><div>10K+</div><div>Downloads</div></div>
  <span>In-app purchases</span><span>Contains ads</span>
  <img data-screenshot-index="0" src="${image}/shot"><img data-screenshot-index="1" src="http://127.0.0.1/private">
  <img data-screenshot-index="2" src="${image}/shot"><img data-screenshot-index="3" src="https://play-lh.googleusercontent.com.evil.test/shot">
  <a href="https://policies.google.com/privacy">Privacy Policy</a>
  <a href="https://example.com/privacy"><i>shield</i>Privacy Policy</a><a href="https://example.com"><i>public</i>Website</a>`;
const signal = () => new AbortController().signal;

test('Play links parse package IDs and country while rejecting non-store fetch targets and ambiguous IDs', () => {
  assert.deepEqual(parseStoreUrl(url), { provider: 'google', id: 'com.example.journal', country: 'FR' });
  assert.deepEqual(parseStoreUrl(url.replace('/details?', '/details/Dog_Journal?')), parseStoreUrl(url));
  assert.equal(parseStoreUrl('https://apps.apple.com/us/app/id123')?.provider, 'apple');
  for (const bad of ['http://play.google.com/store/apps/details?id=com.example', 'https://play.google.com.evil.test/store/apps/details?id=com.example',
    'https://play.google.com@evil.test/store/apps/details?id=com.example', 'https://user:pass@play.google.com/store/apps/details?id=com.example',
    'https://play.google.com:8443/store/apps/details?id=com.example', 'https://play.google.com/store/apps/developer?id=com.example',
    'https://play.google.com/store/apps/details?id=../../private', 'https://play.google.com/store/apps/details?id=com.example&id=other.app',
    'https://127.0.0.1/store/apps/details?id=com.example']) {
    assert.equal(parseStoreUrl(bad), undefined, bad); assert.equal(appStoreImportSchema.safeParse({ url: bad }).success, false);
  }
});
test('Play imports use a fixed endpoint, selected country and English listing; no tracking or user language parameters', async () => {
  const source = await fetchGooglePlayListing(url, 'GB', signal(), async (target, options) => {
    assert.equal(String(target), googlePlayUrl('com.example.journal', 'GB')); assert.equal(options?.redirect, 'error');
    return new Response(html());
  });
  assert.equal(source.country, 'GB'); assert.equal(source.name, 'Dog & Me');
  assert.match(source.description, /Track walks & observations/u); assert.match(source.description, /\n\n/u);
  assert.match(source.description, /require a subscription/u); assert.equal(source.downloadPrice, 'Free');
  assert.equal(source.ratingCount, 123); assert.equal(source.inAppPurchases, true); assert.equal(source.containsAds, true);
  assert.equal(source.screenshots.length, 1); assert.equal(source.privacyUrl, 'https://example.com/privacy');
  assert.equal(source.developerUrl, 'https://example.com/'); assert.equal(source.downloads, '10K+');
  assert.equal(source.updatedAt, 'Oct 4, 2026'); assert.ok(Number.isFinite(Date.parse(source.checkedAt)));
});
test('Play parsing rejects unrelated apps, consent pages, partial descriptions and malformed listing data', () => {
  assert.throws(() => parseGooglePlayListing('<html>Consent required</html>', 'com.example.journal', 'US'), /did not return/u);
  assert.throws(() => parseGooglePlayListing(html({ ...record, url: url.replace('com.example.journal', 'other.app') }), 'com.example.journal', 'US'), /did not return/u);
  assert.throws(() => parseGooglePlayListing(`<script type="application/ld+json">${JSON.stringify(record)}</script>`, 'com.example.journal', 'US'), /full app description/u);
  assert.throws(() => parseGooglePlayListing(html({ ...record, aggregateRating: { ratingValue: 6, ratingCount: 2 } }), 'com.example.journal', 'US'), /incomplete/u);
});
test('Play failures are bounded and do not leak remote content; cancellation propagates', async () => {
  for (const [status, pattern] of [[404, /not found/u], [429, /too many requests/u], [500, /could not return/u]] as const) {
    await assert.rejects(fetchGooglePlayListing(url, undefined, signal(), async () => new Response('private upstream detail', { status })), pattern);
  }
  await assert.rejects(fetchGooglePlayListing(url, undefined, signal(), async () => new Response('x'.repeat(4_000_001))), /unexpectedly large/u);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fetchGooglePlayListing(url, undefined, abort.signal, async () => { throw new Error('Must not fetch'); }), { name: 'AbortError' });
});
test('Play source facts flow into an automatic brief and can be saved without inventing an unstated audience', async () => {
  const result = await importAppStoreProfile({ url, language: 'English', summarize: true }, signal(), { fetcher: async () => new Response(html()), aiConfigured: true,
    generate: async input => {
      assert.match(input.system!, /Google Play/u); assert.equal((input.prompt as { language: string }).language, 'English');
      return { benefit: { text: 'Log walks and observations.', quote: 'Track walks & observations.' }, audience: { text: '', quote: '' },
        features: [{ text: 'Pro reminders need a subscription.', quote: 'Pro reminders require a subscription.' }], callToAction: 'Try Dog & Me' };
    } });
  assert.equal(result.summarized, true); assert.equal(result.suggestions.callToAction, 'Try Dog & Me');
  const profile = { id: randomUUID(), ...result.suggestions, audience: '', storeUrl: url, country: 'FR', language: 'English', hashtags: [], appStore: result.source };
  assert.equal(promotionProfileSchema.safeParse(profile).success, true);
  assert.equal(promotionProfileSchema.safeParse({ ...profile, storeUrl: 'https://apps.apple.com/us/app/id123' }).success, false);
});
test('Apple supplementary facts retain regional prices; redirects cannot fetch another app or private host', async () => {
  const source = { provider: 'apple' as const, appId: '123', url: 'https://apps.apple.com/us/app/id123', country: 'US', checkedAt: new Date().toISOString(),
    name: 'Pup', description: 'A journal.', developer: '', category: '', version: '', languages: [], downloadPrice: 'Free', screenshots: [] };
  const page = '<link rel="canonical" href="https://apps.apple.com/us/app/pup/id123"><dl><div><dt>In-App Purchases</dt><dd><summary>Yes</summary><ul><li><span>Yearly Pro</span><span>$49.99</span></li></ul></dd></div></dl>';
  assert.equal(appleListingExtras(page, source).purchaseDetails, 'Yearly Pro — $49.99');
  assert.equal(appleListingExtras(page.replace('id123', 'id999'), source).purchaseDetails, undefined);
  let calls = 0;
  const result = await enrichAppleListing(source, signal(), async target => {
    calls++; assert.match(String(target), /^https:\/\/apps\.apple\.com\/us\/app\//u);
    return calls === 1 ? new Response(null, { status: 301, headers: { location: 'https://apps.apple.com/us/app/pup/id123' } }) : new Response(page);
  });
  assert.equal(calls, 2); assert.equal(result.inAppPurchases, true);
  for (const location of ['https://127.0.0.1/private', 'https://apps.apple.com/us/app/id999', 'https://apps.apple.com/fr/app/id123']) {
    let count = 0;
    await assert.rejects(fetchStorePage(source.url, 'App Store', signal(), async () => { count++; return new Response(null, { status: 301, headers: { location } }); }, true), /unexpected redirect/u);
    assert.equal(count, 1);
  }
});
