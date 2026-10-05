import { useEffect, useRef, useState } from 'react';
import { Copy, Sparkles, X } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { postContent,
  type PostDraft, type PostPlatform, type PostizChannel, type PromotionProfile, type Publication } from '../shared/publishing';
import { exportTitle } from '../shared/export-presentation';
import { apiRequest } from './api-client';
import PromotionProfileEditor from './PromotionProfileEditor';
import AppStoreSourceCard from './AppStoreSourceCard';
import PostLanguageSelect from './PostLanguageSelect';
import { DEFAULT_PUBLISHING_LANGUAGE } from '../shared/publishing-language';
import PublicationList from './PublicationList';
import CrossPostScheduler from './CrossPostScheduler';
import './publishing.css';

interface PublishingConfig { configured: boolean; dashboard: string; aiConfigured: boolean; profiles: PromotionProfile[] }
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export default function PublishingPanel({ job, onClose, onJobSaved }: { job: RenderJob | null; onClose: () => void; onJobSaved: (job: RenderJob) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [config, setConfig] = useState<PublishingConfig>(), [channels, setChannels] = useState<PostizChannel[]>([]), [channelError, setChannelError] = useState('');
  const [publications, setPublications] = useState<Publication[]>([]), [platform, setPlatform] = useState<PostPlatform>('tiktok');
  const [publicationTotal, setPublicationTotal] = useState(0);
  const [draft, setDraft] = useState<PostDraft>(), [profileId, setProfileId] = useState(''), [editingProfile, setEditingProfile] = useState<PromotionProfile | 'new' | null>(null);
  const [postLanguage, setPostLanguage] = useState<string | null>(null);
  const [tab, setTab] = useState<'copy' | 'schedule' | 'queue'>(job ? 'copy' : 'queue'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [tags, setTags] = useState('');
  const profile = config?.profiles.find(profile => profile.id === profileId);
  const language = postLanguage ?? profile?.language ?? DEFAULT_PUBLISHING_LANGUAGE;
  const current = draft ? { ...draft, hashtags: tags.trim().split(/\s+/u).filter(Boolean) } : undefined;
  const dirty = useRef(false);
  const close = () => { if (!busy && !dirty.current) onClose(); else if (!busy) setNotice('Save your post copy before closing, or use Discard changes.'); };
  const loadPublications = async (append = false) => {
    const query = new URLSearchParams({ offset: String(append ? publications.length : 0), ...(job ? { jobId: job.id } : {}) });
    const data = await apiRequest<{ publications: Publication[]; total: number }>(`/api/publishing/publications?${query}`);
    setPublicationTotal(data.total);
    setPublications(entries => append ? [...entries, ...data.publications.filter(item => !entries.some(previous => previous.id === item.id))] : data.publications);
    return data.publications;
  };
  const loadChannels = async () => {
    setChannelError('');
    try { const data = await apiRequest<{ channels: PostizChannel[] }>('/api/publishing/channels'); setChannels(data.channels); }
    catch (error) { setChannelError((error as Error).message); }
  };
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void apiRequest<PublishingConfig>('/api/publishing/config', { signal: abort.signal }).then(data => {
      setConfig(data); setProfileId(current => current || data.profiles[0]?.id || '');
      if (data.configured) void loadChannels();
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    void loadPublications().catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!job) return;
    const abort = new AbortController(); setDraft(undefined); setError('');
    void apiRequest<PostDraft>(`/api/publishing/jobs/${job.id}/draft?platform=${platform}`, { signal: abort.signal }).then(data => {
      if (abort.signal.aborted) return; setDraft(data); setTags(data.hashtags.join(' ')); dirty.current = false;
      setPostLanguage(data.language ?? null);
      if (data.profileId) setProfileId(data.profileId);
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [job?.id, platform]);
  const patch = (value: Partial<PostDraft>) => { if (draft) { setDraft({ ...draft, ...value }); dirty.current = true; setNotice(''); } };
  const saveCopy = async () => {
    if (!current || !job) return;
    const { platform, title, short, long, hashtags, selected } = current;
    const saved = await apiRequest<PostDraft>(`/api/publishing/jobs/${job.id}/draft`, json({ platform, title, short, long, hashtags, selected }, 'PUT'));
    setDraft(saved); setTags(saved.hashtags.join(' ')); dirty.current = false;
  };
  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  };
  const copy = async (length: 'short' | 'long') => {
    if (!current) return;
    try { await navigator.clipboard.writeText(postContent(current, length)); setNotice(`${length === 'short' ? 'Short' : 'Long'} caption and hashtags copied.`); }
    catch { setError('Clipboard access is unavailable. Select the caption text and hashtags to copy them.'); }
  };
  const upsertProfile = (saved: PromotionProfile) => { setConfig(value => value && ({ ...value, profiles: [saved, ...value.profiles.filter(profile => profile.id !== saved.id)] })); setProfileId(saved.id); setPostLanguage(null); setEditingProfile(null); setNotice('App profile saved.'); };
  return <dialog ref={dialog} className="publishing-dialog" aria-labelledby="publishing-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><small>APP PROMOTION</small><h2 id="publishing-title">{job ? exportTitle(job) : 'App profiles & scheduled posts'}</h2></div><button type="button" aria-label="Close publishing" className="icon-button" disabled={!!busy} onClick={close}><X size={20} /></button></header>
    <nav aria-label="Publishing steps">{job && <><button aria-current={tab === 'copy' ? 'step' : undefined} disabled={!!busy} onClick={() => setTab('copy')}>1 · Post copy</button><button aria-current={tab === 'schedule' ? 'step' : undefined} disabled={!!busy || !draft} onClick={() => void run('Saving copy…', async () => { await saveCopy(); setTab('schedule'); })}>2 · Accounts & schedule</button></>}<button aria-current={tab === 'queue' ? 'step' : undefined} disabled={!!busy} onClick={() => setTab('queue')}>Scheduled posts</button></nav>
    <div className="publishing-body">
      {error && <p className="publishing-error" role="alert">{error}</p>}{notice && <p className="publishing-notice" role="status">{notice}</p>}
      {busy && <p role="status">{busy}{busy.startsWith('Uploading') ? ' Keep this window open until Postiz confirms the schedule.' : ''}</p>}
      {config && <details className="publishing-profiles" open={editingProfile !== null || (!config.profiles.length && tab === 'copy')}>
        <summary>App profiles · {profile?.name || 'Set your app, audience and market'}</summary>
        <div className="publishing-row"><label>Mobile app<select value={profileId} disabled={!!busy || !!editingProfile} onChange={e => { setProfileId(e.target.value); setPostLanguage(null); }}><option value="">Choose an app</option>{config.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.country}</option>)}</select></label>
          <button className="secondary-button" disabled={!!busy || !!editingProfile} onClick={() => setEditingProfile('new')}>Add app</button>{profile && <button className="secondary-button" disabled={!!busy || !!editingProfile} onClick={() => setEditingProfile(profile)}>Edit app</button>}</div>
        {profile?.appStore && !editingProfile && <><AppStoreSourceCard source={profile.appStore} compact />{profile.appStore.country !== profile.country && <p className="publishing-note">This listing is for {profile.appStore.country}; your target is {profile.country}. Use Edit app → Refresh listing to check the target market.</p>}</>}
        {editingProfile && <PromotionProfileEditor key={editingProfile === 'new' ? 'new' : editingProfile.id} profile={editingProfile === 'new' ? undefined : editingProfile} aiConfigured={config.aiConfigured} onSaved={upsertProfile} onCancel={() => setEditingProfile(null)} onImporting={active => setBusy(active ? 'Importing app details…' : '')} />}
      </details>}
      {job && tab === 'copy' && <div className="publishing-row"><label>Caption for<select value={platform} disabled={!!busy || !!editingProfile} onChange={e => { if (dirty.current) { setNotice('Save the current caption before switching platforms.'); return; } setPlatform(e.target.value as PostPlatform); }}><option value="tiktok">TikTok</option><option value="instagram">Instagram Reels</option><option value="youtube">YouTube</option></select></label><PostLanguageSelect label="Post language" value={language} onChange={setPostLanguage} disabled={!!busy || !!editingProfile || !profile || !draft} />{profile && <span>Target: {profile.country}</span>}</div>}
      {tab === 'copy' && job && draft && <section aria-label="Post copy">
        <div className="publishing-actions"><button className="primary-button" disabled={!!busy || !profile || !!editingProfile} onClick={() => void run(config?.aiConfigured ? 'Writing two captions…' : 'Preparing hook…', async () => {
          const result = await apiRequest<PostDraft>(`/api/publishing/jobs/${job.id}/generate`, json({ platform, profileId, language })); setDraft(result); setTags(result.hashtags.join(' ')); dirty.current = false;
        })}><Sparkles size={15} />{config?.aiConfigured ? 'Generate short & long · DeepSeek' : 'Use hook & app hashtags'}</button></div>
        <p className="publishing-note">{config?.aiConfigured ? `Generates titles, short and long captions, calls to action and descriptive hashtags in ${language}. Uses the app profile and this export’s saved text. DeepSeek usage is billed by your API provider.` : `DeepSeek is unavailable. The original hook and saved hashtags are copied without translation; write your caption in ${language} before posting.`}</p>
        {draft.language && draft.language !== language && <p className="publishing-note" role="status">This copy was generated in {draft.language}. Generate again to create it in {language}; changing this selector does not translate existing text.</p>}
        {draft.profileId && draft.profileId !== profileId && <p className="publishing-note">This caption was written for a different app profile. Generate new copy or review the text before scheduling.</p>}
        <label>Post title<input value={draft.title} maxLength={platform === 'tiktok' ? 90 : 100} disabled={!!busy} onChange={event => patch({ title: event.target.value })} /></label>
        <p>{draft.reason}</p>
        <div className="post-copy-variants">{(['short', 'long'] as const).map(length => <article key={length}>
          <div className="publishing-row"><label className="publishing-choice"><input type="radio" name="post-length" checked={draft.selected === length} disabled={!!busy} onChange={() => patch({ selected: length })} />{length === 'short' ? 'Short caption' : 'Long caption'}</label>{draft.recommended === length && draft.provider === 'deepseek' && <small>Suggested starting point</small>}</div>
          <textarea aria-label={length === 'short' ? 'Short post caption' : 'Long post caption'} rows={length === 'short' ? 4 : 8} maxLength={5000} value={draft[length]} disabled={!!busy} onChange={e => patch({ [length]: e.target.value })} />
          <button className="secondary-button" type="button" onClick={() => void copy(length)}><Copy size={14} />Copy {length} + hashtags</button>
        </article>)}</div>
        <label>Hashtags — editable, up to eight<input value={tags} disabled={!!busy} onChange={event => { setTags(event.target.value); dirty.current = true; }} /></label>
        <p className="publishing-note">{draft.trendNote}</p>
        {!!draft.trends.length && <ul className="trend-references">{draft.trends.map(item => <li key={item.tag}><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.tag}</a> · {item.country} · observed {new Date(item.observedAt).toLocaleString()}{Date.now() - Date.parse(item.observedAt) > 24 * 3600000 ? ' · stale: recheck before posting' : ''}</li>)}</ul>}
        {platform === 'tiktok' && <a href="https://ads.tiktok.com/creative/creativeCenter/trends" target="_blank" rel="noreferrer">Check TikTok Creative Center trends</a>}
        <p className="publishing-note">Compare short and long captions using app visits and attributed installs. This recommendation is a starting hypothesis, not measured performance.</p>
        <div className="publishing-actions"><button className="secondary-button" disabled={!!busy} onClick={() => void run('Saving copy…', async () => { await saveCopy(); setNotice('Post copy saved.'); })}>Save copy</button><button className="primary-button" disabled={!!busy} onClick={() => void run('Saving copy…', async () => { await saveCopy(); setTab('schedule'); })}>Choose accounts &amp; schedule</button></div>
      </section>}
      {job && draft && config && <CrossPostScheduler key={job.id} visible={tab === 'schedule'} job={job} seed={draft} channels={channels} publications={publications} configured={config.configured} dashboard={config.dashboard} channelError={channelError} disabled={!!busy || !!editingProfile}
        onRefresh={() => void run('Refreshing accounts…', loadChannels)} onBusy={active => setBusy(active ? 'Uploading video and scheduling accounts…' : '')}
        onFinished={async saved => { onJobSaved(saved); await loadPublications(); }} onViewPosts={() => setTab('queue')} />}
      {tab === 'queue' && <><div className="publishing-row"><h3>{job ? 'Posts for this export' : 'Scheduled posts'}</h3><button className="secondary-button" disabled={!!busy} onClick={() => void run('Loading saved posts…', async () => { await loadPublications(); })}>Reload list</button></div><PublicationList publications={publications} dashboard={config?.dashboard || 'https://platform.postiz.com'} onUpdated={updated => setPublications(entries => entries.map(entry => entry.id === updated.id ? updated : entry))} />{publications.length < publicationTotal && <button className="secondary-button" disabled={!!busy} onClick={() => void run('Loading older posts…', async () => { await loadPublications(true); })}>Load older posts · {publications.length} of {publicationTotal}</button>}</>}
      {dirty.current && <button type="button" className="publishing-discard" disabled={!!busy} onClick={onClose}>Discard unsaved copy changes &amp; close</button>}
    </div>
  </dialog>;
}
