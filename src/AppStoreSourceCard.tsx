import { storeName, type AppStoreSource } from '../shared/app-store';

export default function AppStoreSourceCard({ source, compact = false }: { source: AppStoreSource; compact?: boolean }) {
  const store = storeName(source.provider);
  return <aside className={`app-store-source${compact ? ' compact' : ''}`} aria-label={`Imported ${store} listing`}>
    <div className="app-store-source-heading">
      {source.iconUrl && <img src={source.iconUrl} alt="" width={52} height={52} referrerPolicy="no-referrer" />}
      <div><strong>{source.name}</strong>{source.subtitle && !compact && <p>{source.subtitle}</p>}<p><a href={source.url} target="_blank" rel="noreferrer">{store} · {source.country}</a> · Retrieved <time dateTime={source.checkedAt}>{new Date(source.checkedAt).toLocaleString()}</time></p></div>
    </div>
    {Date.now() - Date.parse(source.checkedAt) > 24 * 3600000 && <p className="publishing-note">Listing retrieved more than 24 hours ago. Use Edit app → Refresh listing to check for changes.</p>}
    {!compact && <details><summary>View imported facts and screenshots</summary>
      <p>{[source.developer, source.category, source.version && `Version ${source.version}`].filter(Boolean).join(' · ')}</p>
      {source.downloadPrice && <p>Download price: {source.downloadPrice}. In-app purchases and subscriptions may cost extra.</p>}
      {source.inAppPurchases && <p>Offers in-app purchases{source.purchaseDetails ? `: ${source.purchaseDetails}` : '. Prices were not provided by the listing.'}</p>}
      {source.containsAds && <p>Contains ads.</p>}
      {(source.contentRating || source.minimumOsVersion) && <p>{[source.contentRating && `Age/content rating: ${source.contentRating}`, source.minimumOsVersion && `Requires iOS ${source.minimumOsVersion}+`].filter(Boolean).join(' · ')}</p>}
      {(source.updatedAt || source.downloads) && <p>{[source.updatedAt && `Updated: ${source.updatedAt}`, source.downloads && `Downloads: ${source.downloads}`].filter(Boolean).join(' · ')}</p>}
      {!!source.ratingCount && source.rating !== undefined && <p>{source.rating.toFixed(1)} / 5 from {source.ratingCount.toLocaleString()} ratings in {source.country}.</p>}
      {!!source.languages.length && <p>Supported app languages: {source.languages.join(', ')}. Content language is chosen separately; the original listing below stays as published by the developer.</p>}
      <p className="app-store-description">{source.description}</p>
      {source.releaseNotes && <details><summary>What’s new</summary><p className="app-store-description">{source.releaseNotes}</p></details>}
      {(source.developerUrl || source.privacyUrl) && <p>{source.developerUrl && <a href={source.developerUrl} target="_blank" rel="noreferrer">Developer website</a>}{source.developerUrl && source.privacyUrl && ' · '}{source.privacyUrl && <a href={source.privacyUrl} target="_blank" rel="noreferrer">Privacy policy</a>}</p>}
      {!!source.screenshots.length && <div className="app-store-screenshots">{source.screenshots.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer"><img src={url} alt={`${store} screenshot ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /></a>)}</div>}
    </details>}
  </aside>;
}
