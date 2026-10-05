import { useState } from 'react';
import { promotionProfileSchema, type PromotionProfile } from '../shared/publishing';
import { apiRequest } from './api-client';

export default function PromotionProfileEditor({ profile, onSaved, onCancel }: {
  profile?: PromotionProfile; onSaved: (profile: PromotionProfile) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState<PromotionProfile>(profile ?? { id: crypto.randomUUID(), name: '', benefit: '', audience: '', features: '', callToAction: 'Try the app', storeUrl: '', language: 'English', country: 'US', hashtags: [] });
  const [tags, setTags] = useState(value.hashtags.join(' ')), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const field = (key: keyof PromotionProfile, label: string, max: number, required = true, multiline = false) => <label>{label}{multiline
    ? <textarea rows={3} maxLength={max} required={required} value={String(value[key])} onChange={e => setValue({ ...value, [key]: e.target.value })} />
    : <input maxLength={max} required={required} value={String(value[key])} onChange={e => setValue({ ...value, [key]: key === 'country' ? e.target.value.toUpperCase() : e.target.value })} />}</label>;
  return <form className="promotion-profile-form" onSubmit={async event => {
    event.preventDefault(); setError('');
    const parsed = promotionProfileSchema.safeParse({ ...value, hashtags: tags.trim().split(/\s+/u).filter(Boolean) });
    if (!parsed.success) { setError(parsed.error.issues.map(item => `${item.path.join('.')}: ${item.message}`).join('; ')); return; }
    setBusy(true);
    try { onSaved(await apiRequest<PromotionProfile>(`/api/publishing/profiles/${value.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) })); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <h3>{profile ? 'Edit app profile' : 'Add your mobile app'}</h3>
    <p>Give the writer facts it can use. Copy focuses on app visits and installs; it will not invent features, reviews or offers.</p>
    <fieldset disabled={busy}>
      {field('name', 'App name', 80)}{field('storeUrl', 'App Store, Google Play or landing page URL', 2000, false)}
      {field('benefit', 'Main benefit — what problem does the app solve?', 500, true, true)}
      {field('audience', 'Who is it for?', 300)}{field('features', 'Real features, proof and offer details', 2000, false, true)}
      {field('callToAction', 'Call to action — for example, “Try AppName, link in bio”', 200)}
      <div className="publishing-row">{field('language', 'Post language', 60)}{field('country', 'Target country — two-letter code', 2)}</div>
      <label>App hashtags — optional, up to six<input value={tags} onChange={event => setTags(event.target.value)} placeholder="#YourApp #RelevantTopic" /></label>
    </fieldset>
    {error && <p role="alert" className="publishing-error">{error}</p>}
    <div className="publishing-actions"><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save app profile'}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
