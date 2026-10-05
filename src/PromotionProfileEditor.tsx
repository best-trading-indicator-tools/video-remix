import { useEffect, useRef, useState } from 'react';
import { promotionProfileSchema, type PromotionProfile } from '../shared/publishing';
import { apiRequest } from './api-client';
import { parseStoreUrl, type AppStoreImportResult } from '../shared/app-store';
import AppStoreSourceCard from './AppStoreSourceCard';
import PostLanguageSelect from './PostLanguageSelect';
import CountrySelect from './CountrySelect';
import { DEFAULT_PUBLISHING_LANGUAGE } from '../shared/publishing-language';

const briefFields = ['name', 'benefit', 'audience', 'features', 'callToAction'] as const;
type BriefField = typeof briefFields[number];
const identity = (url: string) => { const app = parseStoreUrl(url); return app ? `${app.provider}:${app.id}` : ''; };

export default function PromotionProfileEditor({ profile, aiConfigured = false, onSaved, onCancel, onImporting }: {
  profile?: PromotionProfile; aiConfigured?: boolean; onSaved: (profile: PromotionProfile) => void; onCancel: () => void; onImporting?: (active: boolean) => void;
}) {
  const [value, setValue] = useState<PromotionProfile>(profile ? { ...profile, language: profile.language || DEFAULT_PUBLISHING_LANGUAGE } : { id: crypto.randomUUID(), name: '', benefit: '', audience: '', features: '', callToAction: 'Try the app', storeUrl: '', language: DEFAULT_PUBLISHING_LANGUAGE, country: 'US', hashtags: [] });
  const [tags, setTags] = useState(value.hashtags.join(' ')), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [importing, setImporting] = useState(false), [summarize, setSummarize] = useState(aiConfigured), [replace, setReplace] = useState(false), [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0), [detailsOpen, setDetailsOpen] = useState(false);
  const appLink = parseStoreUrl(value.storeUrl), appIdentity = identity(value.storeUrl);
  const requestKey = appIdentity ? JSON.stringify([appIdentity, value.country, value.language, summarize]) : '';
  const lastAttempt = useRef(profile?.appStore?.country === value.country && appIdentity === `${profile.appStore.provider}:${profile.appStore.appId}` ? requestKey : '');
  const previousIdentity = useRef(appIdentity);
  // Keep user edits, including ones made while a slow import is in flight.
  const edits = useRef(new Map<BriefField, number>(briefFields.filter(key => profile?.[key] && profile[key] !== 'Try the app').map(key => [key, 1])));
  const latest = useRef({ value, replace, onImporting }); latest.current = { value, replace, onImporting };
  const refresh = !!value.appStore && appIdentity === `${value.appStore.provider}:${value.appStore.appId}`;

  useEffect(() => {
    if (!requestKey || requestKey === lastAttempt.current) return;
    const controller = new AbortController();
    setImporting(true); setError(''); setNotice(''); latest.current.onImporting?.(true);
    const timer = window.setTimeout(async () => {
      lastAttempt.current = requestKey;
      const input = latest.current.value, replaceBrief = latest.current.replace, originalEdits = new Map(edits.current);
      try {
        const result = await apiRequest<AppStoreImportResult>('/api/publishing/profiles/import-store', {
          method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: input.storeUrl, country: input.country, language: input.language, summarize }),
        });
        if (controller.signal.aborted) return;
        const suggestions = { ...result.suggestions, callToAction: result.suggestions.callToAction || `Try ${result.suggestions.name}` };
        setValue(current => ({ ...current, ...Object.fromEntries(briefFields.filter(key =>
          !edits.current.has(key) || (replaceBrief && edits.current.get(key) === originalEdits.get(key))).map(key => [key, suggestions[key]])),
          storeUrl: result.source.url, appStore: result.source }));
        if (replaceBrief) for (const key of briefFields) if (edits.current.get(key) === originalEdits.get(key)) edits.current.delete(key);
        setNotice(`${result.note}${edits.current.size ? ' Your edited fields were kept.' : ''}`);
        setReplace(false);
      } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
      finally { if (!controller.signal.aborted) { setImporting(false); latest.current.onImporting?.(false); } }
    }, 650);
    return () => { window.clearTimeout(timer); controller.abort(); setImporting(false); latest.current.onImporting?.(false); };
  }, [requestKey, retry]);

  const changeUrl = (storeUrl: string) => {
    const nextIdentity = identity(storeUrl), parsed = parseStoreUrl(storeUrl);
    const differentApp = !!nextIdentity && !!previousIdentity.current && previousIdentity.current !== nextIdentity;
    if (differentApp) { edits.current.clear(); setTags(''); setNotice(''); }
    if (!nextIdentity) { lastAttempt.current = ''; setError(''); setNotice(''); }
    if (nextIdentity) previousIdentity.current = nextIdentity;
    setValue(current => ({ ...current,
      ...(differentApp ? { name: '', benefit: '', audience: '', features: '', callToAction: 'Try the app', hashtags: [] } : {}),
      storeUrl, country: parsed?.country ?? current.country,
      appStore: nextIdentity === `${current.appStore?.provider}:${current.appStore?.appId}` ? current.appStore : undefined }));
  };
  const field = (key: BriefField, label: string, max: number, multiline = false) => {
    const change = (text: string) => { edits.current.set(key, (edits.current.get(key) || 0) + 1); setValue(current => ({ ...current, [key]: text })); };
    return <label>{label}{multiline
      ? <textarea rows={3} maxLength={max} value={value[key]} onChange={e => change(e.target.value)} />
      : <input maxLength={max} value={value[key]} onChange={e => change(e.target.value)} />}</label>;
  };
  return <form className="promotion-profile-form" noValidate onSubmit={async event => {
    event.preventDefault(); if (busy || importing || (requestKey && requestKey !== lastAttempt.current)) return; setError('');
    const parsed = promotionProfileSchema.safeParse({ ...value, hashtags: tags.trim().split(/\s+/u).filter(Boolean) });
    if (!parsed.success) { setDetailsOpen(true); setError(parsed.error.issues.map(item => `${item.path.join('.')}: ${item.message}`).join('; ')); return; }
    setBusy(true);
    try { onSaved(await apiRequest<PromotionProfile>(`/api/publishing/profiles/${value.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <h3>{profile ? 'Edit app profile' : 'Add your mobile app'}</h3>
    <p>Paste an App Store or Google Play link. We’ll load the listing and fill in your app’s details automatically.</p>
    <fieldset disabled={busy}>
      <section className="app-store-import" aria-label="Import app details" aria-busy={importing}>
        <label>App Store or Google Play link<input type="url" value={value.storeUrl} maxLength={2000} placeholder="Paste your app’s store link…" onChange={event => changeUrl(event.target.value)} /></label>
        <div className="publishing-row"><CountrySelect value={value.country} onChange={country => setValue(current => ({ ...current, country }))} /><PostLanguageSelect label="Default content language" value={value.language} onChange={language => setValue(current => ({ ...current, language }))} /></div>
        <p className="publishing-note">English by default. Changing the country or language reloads the details; your manual edits are kept.</p>
        {importing && <p role="status">Loading app details{summarize ? ' and preparing your promotion brief' : ''}…</p>}
        {notice && <p className="publishing-notice" role="status">{notice}</p>}
        {error && <p role="alert" className="publishing-error">{error}</p>}
        {(refresh || error) && appLink && <button type="button" className="secondary-button" disabled={importing} onClick={() => { lastAttempt.current = ''; setRetry(value => value + 1); }}>{error ? 'Retry loading app' : 'Refresh listing'}</button>}
        <details><summary>Import options</summary>
          {aiConfigured && <label className="publishing-choice"><input type="checkbox" checked={summarize} onChange={event => setSummarize(event.target.checked)} />Prepare the brief with DeepSeek · API usage is billed</label>}
          {refresh && <label className="publishing-choice"><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Replace my edited brief on the next refresh</label>}
          <p className="publishing-note">The store supplies app facts, images and pricing where available. Social trends are checked separately for each export. Website links can be used with manually entered details.</p>
        </details>
      </section>
      {value.appStore && <AppStoreSourceCard source={value.appStore} />}
      {value.appStore && value.appStore.country !== value.country && !importing && <p className="publishing-note">The saved listing is for {value.appStore.country}. Retry loading to get the details for {value.country}.</p>}
      {value.appStore && value.benefit && <p className="promotion-brief-preview">{value.benefit}</p>}
      <details className="promotion-brief" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
        <summary>{value.appStore ? 'Review & edit app details' : 'Enter app details manually'}</summary>
        {field('name', 'App name', 80)}
        {field('benefit', 'Main benefit — what problem does the app solve?', 500, true)}
        {field('audience', 'Who is it for? — optional if not stated in the listing', 300)}
        {field('features', 'Real features, proof and offer details', 2000, true)}
        {field('callToAction', 'Call to action', 200)}
        <label>App hashtags — optional, up to six<input value={tags} onChange={event => setTags(event.target.value)} placeholder="#YourApp #RelevantTopic" /></label>
      </details>
    </fieldset>
    <div className="publishing-actions"><button className="primary-button" disabled={busy || importing || !value.name || !value.benefit}>{busy ? 'Saving…' : 'Save app profile'}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
