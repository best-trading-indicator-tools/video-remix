import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { appStoreImportSchema, parseAppStoreUrl } from '../shared/app-store.js';
import { promotionProfileSchema } from '../shared/publishing.js';
import { AppStoreError, fetchAppStoreListing, importAppStoreProfile } from '../server/app-store.js';

const url = 'https://apps.apple.com/us/app/pup-ai-dog-health-journal/id6800214459?utm_source=campaign';
const description = 'A private dog wellness journal for dog owners.\n\nTrack everyday observations.\n\nPro reminders require a subscription.\n\nInformational only; no recommendations.';
const record = { trackId: 6800214459, kind: 'software', trackName: 'Pup AI', description, sellerName: 'Developer', primaryGenreName: 'Health & Fitness',
  formattedPrice: 'Free', version: '1.5', languageCodesISO2A: ['EN'], averageUserRating: 4.7, userRatingCount: 3,
  artworkUrl512: 'https://is1-ssl.mzstatic.com/image/icon.png', screenshotUrls: ['https://is1-ssl.mzstatic.com/image/shot.png', 'http://127.0.0.1/private', 'https://mzstatic.com.evil.test/photo.png'] };
const fetcher: typeof fetch = async () => Response.json({ resultCount: 1, results: [record] });
const signal = () => new AbortController().signal;

test('App Store imports accept current and legacy listing links but reject arbitrary fetch targets', () => {
  assert.deepEqual(parseAppStoreUrl(url), { id: '6800214459', country: 'US' });
  assert.deepEqual(parseAppStoreUrl('https://itunes.apple.com/fr/app/id6800214459'), { id: '6800214459', country: 'FR' });
  assert.deepEqual(parseAppStoreUrl('https://apps.apple.com/app/pup/id6800214459'), { id: '6800214459', country: undefined });
  for (const bad of ['http://apps.apple.com/us/app/id12', 'https://apps.apple.com.evil.test/us/app/id12', 'https://apps.apple.com@evil.test/us/app/id12',
    'https://user:secret@apps.apple.com/us/app/id12', 'https://apps.apple.com:8443/us/app/id12', 'https://127.0.0.1/app/id12',
    'https://apps.apple.com/us/developer/id12', 'https://apps.apple.com/us/app/id12/more', 'https://apps.apple.com/us/app/id0', 'https://apps.apple.com/us/app/id9999999999999999']) {
    assert.equal(parseAppStoreUrl(bad), undefined, bad);
    assert.equal(appStoreImportSchema.safeParse({ url: bad }).success, false);
  }
});
test('Apple lookup uses a fixed endpoint, the requested market, bounded facts and a dated canonical source', async () => {
  const before = Date.now(); let calls = 0;
  const source = await fetchAppStoreListing(url, 'FR', signal(), async (target, options) => {
    calls++; const endpoint = new URL(String(target));
    assert.equal(endpoint.origin + endpoint.pathname, 'https://itunes.apple.com/lookup');
    assert.equal(endpoint.searchParams.get('country'), 'fr'); assert.equal(endpoint.searchParams.get('id'), '6800214459');
    assert.equal(endpoint.searchParams.has('utm_source'), false); assert.equal(options?.redirect, 'error');
    return fetcher(target, options);
  });
  assert.equal(calls, 1); assert.equal(source.url, 'https://apps.apple.com/fr/app/id6800214459'); assert.equal(source.country, 'FR');
  assert.ok(Date.parse(source.checkedAt) >= before); assert.equal(source.description, description); assert.equal(source.downloadPrice, 'Free');
  assert.equal(source.ratingCount, 3); assert.equal(source.screenshots.length, 1); assert.ok(!('subscriptionPrice' in source));
  let country = '';
  await fetchAppStoreListing(url.replace('/us/', '/gb/'), undefined, signal(), async target => { country = new URL(String(target)).searchParams.get('country')!; return fetcher(target); });
  assert.equal(country, 'gb');
});
test('unavailable markets do not silently use another storefront; Apple failures are actionable and bounded', async () => {
  await assert.rejects(fetchAppStoreListing(url, 'FR', signal(), async () => Response.json({ resultCount: 0, results: [] })), error => error instanceof AppStoreError && error.status === 404 && error.message.includes('FR'));
  await assert.rejects(fetchAppStoreListing(url, undefined, signal(), async () => Response.json({ resultCount: 1, results: [{ ...record, trackId: 12 }] })), /not found/u);
  await assert.rejects(fetchAppStoreListing(url, undefined, signal(), async () => new Response('secret remote body', { status: 429 })), error => error instanceof AppStoreError && error.status === 429 && !error.message.includes('secret'));
  await assert.rejects(fetchAppStoreListing(url, undefined, signal(), async () => new Response('x'.repeat(512001))), /unexpectedly large/u);
  await assert.rejects(fetchAppStoreListing(url, undefined, signal(), async () => new Response('invalid JSON')), /could not be reached/u);
  await assert.rejects(fetchAppStoreListing(url, undefined, signal(), async () => { throw new Error('private network detail'); }), error => error instanceof AppStoreError && !error.message.includes('private network'));
});
test('free import preserves original facts without inferring an audience, pricing or hashtags', async () => {
  const result = await importAppStoreProfile({ url, language: 'French', summarize: false }, signal(), { fetcher, aiConfigured: true, generate: async () => { throw new Error('Must not bill AI'); } });
  assert.equal(result.summarized, false); assert.equal(result.suggestions.audience, ''); assert.equal(result.suggestions.benefit, description.split('\n')[0]);
  assert.equal(result.suggestions.features, description); assert.ok(!('hashtags' in result.suggestions));
  const unavailable = await importAppStoreProfile({ url, language: 'French', summarize: true }, signal(), { fetcher, aiConfigured: false });
  assert.equal(unavailable.summarized, false); assert.match(unavailable.note, /DeepSeek is unavailable/u);
});
test('AI briefs require source quotes, preserve limitations in their context and fail back to the original listing', async () => {
  const request = { url, language: 'French', summarize: true };
  const good = { benefit: { text: 'Consigner les observations quotidiennes.', quote: 'Track everyday observations.' },
    audience: { text: 'Propriétaires de chiens', quote: 'for dog owners' },
    features: [{ text: 'Rappels Pro sur abonnement', quote: 'Pro reminders require a subscription.' }, { text: 'Journal informatif, sans recommandations', quote: 'Informational only; no recommendations.' }] };
  const result = await importAppStoreProfile(request, signal(), { fetcher, aiConfigured: true, generate: async input => {
    assert.equal((input.prompt as { language: string }).language, 'French'); assert.match(input.system!, /Free download does not mean a free service/u); return good;
  } });
  assert.equal(result.summarized, true); assert.equal(result.suggestions.audience, good.audience.text); assert.match(result.suggestions.features, /abonnement/u);
  for (const generate of [async () => ({ ...good, audience: { text: 'Vets', quote: 'invented quote' } }), async () => { throw new Error('Provider failure'); }]) {
    const fallback = await importAppStoreProfile(request, signal(), { fetcher, aiConfigured: true, generate });
    assert.equal(fallback.summarized, false); assert.equal(fallback.suggestions.features, description); assert.equal(fallback.source.name, 'Pup AI');
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(importAppStoreProfile(request, abort.signal, { fetcher, aiConfigured: true, generate: async () => { throw abort.signal.reason; } }), { name: 'AbortError' });
});
test('saved profiles accept dated listing metadata, retain legacy compatibility and reject mismatched provenance', async () => {
  const appStore = await fetchAppStoreListing(url, undefined, signal(), fetcher);
  const profile = { id: randomUUID(), name: 'Pup', benefit: 'Journal', audience: 'Dog owners', features: '', callToAction: 'Try Pup', storeUrl: url, language: 'English', country: 'US', hashtags: [] };
  assert.equal(promotionProfileSchema.safeParse(profile).success, true);
  assert.equal(promotionProfileSchema.safeParse({ ...profile, appStore }).success, true);
  assert.equal(promotionProfileSchema.safeParse({ ...profile, storeUrl: 'https://apps.apple.com/us/app/id12', appStore }).success, false);
  assert.equal(promotionProfileSchema.safeParse({ ...profile, appStore: { ...appStore, url: 'https://evil.test' } }).success, false);
});
test('a French store link still defaults the generated brief to English and retains original source quotes', async () => {
  const frenchDescription = 'Un journal pour les propriétaires de chiens. Consignez vos observations quotidiennes.';
  const request = appStoreImportSchema.parse({ url: url.replace('/us/', '/fr/'), summarize: true });
  assert.equal(request.language, 'English');
  const result = await importAppStoreProfile(request, signal(), { aiConfigured: true,
    fetcher: async () => Response.json({ resultCount: 1, results: [{ ...record, description: frenchDescription }] }),
    generate: async input => {
      assert.equal((input.prompt as { language: string }).language, 'English');
      assert.match(input.system!, /even if the listing or target country uses another language/u);
      return { benefit: { text: 'Keep a journal of daily observations.', quote: 'Consignez vos observations quotidiennes.' },
        audience: { text: 'Dog owners', quote: 'propriétaires de chiens' }, features: [] };
    } });
  assert.equal(result.source.country, 'FR'); assert.equal(result.source.description, frenchDescription);
  assert.equal(result.suggestions.benefit, 'Keep a journal of daily observations.'); assert.equal(result.suggestions.audience, 'Dog owners');
  assert.equal(result.suggestions.features, '', 'An empty translated field must not fall back to French source text');
});
