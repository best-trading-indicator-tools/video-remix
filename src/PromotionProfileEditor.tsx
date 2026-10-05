import { useState } from 'react';
import { promotionProfileSchema, type PromotionProfile } from '../shared/publishing';
import { apiRequest } from './api-client';
import { parseAppStoreUrl, type AppStoreImportResult } from '../shared/app-store';
import AppStoreSourceCard from './AppStoreSourceCard';
import PostLanguageSelect from './PostLanguageSelect';
import { DEFAULT_PUBLISHING_LANGUAGE } from '../shared/publishing-language';

export default function PromotionProfileEditor({ profile, aiConfigured = false, onSaved, onCancel, onImporting }: {
  profile?: PromotionProfile; aiConfigured?: boolean; onSaved: (profile: PromotionProfile) => void; onCancel: () => void; onImporting?: (active: boolean) => void;
}) {
  const [value, setValue] = useState<PromotionProfile>(profile ? { ...profile, language: profile.language || DEFAULT_PUBLISHING_LANGUAGE } : { id: crypto.randomUUID(), name: '', benefit: '', audience: '', features: '', callToAction: 'Try the app', storeUrl: '', language: DEFAULT_PUBLISHING_LANGUAGE, country: 'US', hashtags: [] });
  const [tags, setTags] = useState(value.hashtags.join(' ')), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [importing, setImporting] = useState(false), [summarize, setSummarize] = useState(aiConfigured && !profile?.appStore), [replace, setReplace] = useState(false), [notice, setNotice] = useState('');
  const locked = busy || importing;
  const appLink = parseAppStoreUrl(value.storeUrl);
  const refresh = !!value.appStore && appLink?.id === value.appStore.appId;
  const hasText = !!(value.name || value.benefit || value.audience || value.features);
  const importApp = async () => {
    setImporting(true); onImporting?.(true); setError(''); setNotice('');
    try {
      const result = await apiRequest<AppStoreImportResult>('/api/publishing/profiles/import-app-store', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value.storeUrl, country: value.country, language: value.language, summarize }) });
      setValue(current => ({ ...current, ...Object.fromEntries(Object.entries(result.suggestions).map(([key, suggestion]) =>
        [key, replace || !current[key as keyof typeof result.suggestions] ? suggestion : current[key as keyof typeof result.suggestions]])),
        storeUrl: result.source.url, appStore: result.source,
        callToAction: current.callToAction === 'Try the app' ? `Try ${result.suggestions.name}` : current.callToAction }));
      setNotice(`${result.note}${hasText && !replace ? ' Your existing profile text was kept; only empty fields were filled.' : ''}`);
      setReplace(false);
    } catch (error) { setError((error as Error).message); } finally { setImporting(false); onImporting?.(false); }
  };
  const field = (key: keyof PromotionProfile, label: string, max: number, required = true, multiline = false) => <label>{label}{multiline
    ? <textarea rows={3} maxLength={max} required={required} value={String(value[key])} onChange={e => setValue({ ...value, [key]: e.target.value })} />
    : <input maxLength={max} required={required} value={String(value[key])} onChange={e => setValue({ ...value, [key]: key === 'country' ? e.target.value.toUpperCase() : e.target.value })} />}</label>;
  return <form className="promotion-profile-form" onSubmit={async event => {
    event.preventDefault(); if (locked) return; setError('');
    const parsed = promotionProfileSchema.safeParse({ ...value, hashtags: tags.trim().split(/\s+/u).filter(Boolean) });
    if (!parsed.success) { setError(parsed.error.issues.map(item => `${item.path.join('.')}: ${item.message}`).join('; ')); return; }
    setBusy(true);
    try { onSaved(await apiRequest<PromotionProfile>(`/api/publishing/profiles/${value.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <h3>{profile ? 'Edit app profile' : 'Add your mobile app'}</h3>
    <p>Paste your App Store link to fill in the app’s details, then review your promotion brief. You can also fill it in manually.</p>
    <fieldset disabled={locked}>
      <section className="app-store-import" aria-label="Import app details">
        <label>App Store, Google Play or landing page URL<input value={value.storeUrl} maxLength={2000} placeholder="https://apps.apple.com/us/app/your-app/id123456789" onChange={event => {
          const storeUrl = event.target.value, parsed = parseAppStoreUrl(storeUrl);
          setValue(current => ({ ...current, storeUrl, country: parsed?.country ?? current.country,
            appStore: parsed?.id === current.appStore?.appId ? current.appStore : undefined }));
        }} /></label>
        <div className="publishing-row">{field('country', 'Target country — two-letter code', 2)}<PostLanguageSelect label="Default content language" value={value.language} onChange={language => setValue(current => ({ ...current, language }))} /></div>
        <p className="publishing-note">English by default, independently of the target country. Used for generated app summaries, titles, captions and descriptive hashtags. Changing language applies when you import or generate again.</p>
        <button type="button" className="secondary-button" disabled={!appLink || !/^[A-Z]{2}$/u.test(value.country)} onClick={() => void importApp()}>{importing ? 'Importing app…' : refresh ? 'Refresh listing' : 'Import app details'}</button>
        <p className="publishing-note">Import uses the App Store in your target country. Google Play and website links can be used with a manually written profile.</p>
        {aiConfigured && <label className="publishing-choice"><input type="checkbox" checked={summarize} onChange={event => setSummarize(event.target.checked)} />Summarize the benefit, audience and features with DeepSeek · API usage is billed</label>}
        {hasText && <label className="publishing-choice"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Replace existing profile text with imported suggestions</label>}
        {hasText && aiConfigured && <p className="publishing-note">To translate this brief, choose a language, enable DeepSeek and Replace existing profile text, then import again.</p>}
      </section>
      {importing && <p role="status">Fetching the listing{summarize ? ' and preparing your promotion brief' : ''}…</p>}
      {notice && <p className="publishing-notice" role="status">{notice}</p>}
      {value.appStore && <><AppStoreSourceCard source={value.appStore} />{value.appStore.country !== value.country && <p className="publishing-note">The saved listing is for {value.appStore.country}. Import again to check availability and details in {value.country}.</p>}</>}
      {field('name', 'App name', 80)}
      {field('benefit', 'Main benefit — what problem does the app solve?', 500, true, true)}
      {field('audience', 'Who is it for?', 300)}{field('features', 'Real features, proof and offer details', 2000, false, true)}
      {field('callToAction', 'Call to action — for example, “Try AppName, link in bio”', 200)}
      <label>App hashtags — optional, up to six<input value={tags} onChange={event => setTags(event.target.value)} placeholder="#YourApp #RelevantTopic" /></label>
      <p className="publishing-note">The listing supplies app facts. Trending hashtags need separate, recent evidence for the target country and the content of each export.</p>
    </fieldset>
    {error && <p role="alert" className="publishing-error">{error}</p>}
    <div className="publishing-actions"><button className="primary-button" disabled={locked}>{busy ? 'Saving…' : 'Save app profile'}</button><button type="button" className="secondary-button" disabled={locked} onClick={onCancel}>Cancel</button></div>
  </form>;
}
