import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Copy, Sparkles, X } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { PLATFORM_NAMES, contentLimit, platformForChannel, postContent, scheduleInstants,
  type PostDraft, type PostPlatform, type PostizChannel, type PromotionProfile, type Publication, type ProviderSettings } from '../shared/publishing';
import { exportTitle } from '../shared/export-presentation';
import { apiRequest } from './api-client';
import PromotionProfileEditor from './PromotionProfileEditor';
import PublicationList from './PublicationList';
import './publishing.css';

interface PublishingConfig { configured: boolean; dashboard: string; aiConfigured: boolean; profiles: PromotionProfile[] }
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export default function PublishingPanel({ job, onClose, onJobSaved }: { job: RenderJob | null; onClose: () => void; onJobSaved: (job: RenderJob) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), requestKey = useRef<{ payload: string; id: string } | null>(null);
  const [config, setConfig] = useState<PublishingConfig>(), [channels, setChannels] = useState<PostizChannel[]>([]), [channelError, setChannelError] = useState('');
  const [publications, setPublications] = useState<Publication[]>([]), [platform, setPlatform] = useState<PostPlatform>('tiktok');
  const [publicationTotal, setPublicationTotal] = useState(0);
  const [draft, setDraft] = useState<PostDraft>(), [profileId, setProfileId] = useState(''), [editingProfile, setEditingProfile] = useState<PromotionProfile | 'new' | null>(null);
  const [tab, setTab] = useState<'copy' | 'schedule' | 'queue'>(job ? 'copy' : 'queue'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [tags, setTags] = useState(''), [channelId, setChannelId] = useState(''), [date, setDate] = useState(''), [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone), [fold, setFold] = useState('');
  const [privacy, setPrivacy] = useState(''), [youtubeVisibility, setYoutubeVisibility] = useState<'public' | 'unlisted' | 'private'>('public'), [kids, setKids] = useState<'yes' | 'no'>('no');
  const [ownBrand, setOwnBrand] = useState(true), [partnership, setPartnership] = useState(false), [aiVideo, setAiVideo] = useState(false);
  const [comments, setComments] = useState(true), [duet, setDuet] = useState(false), [stitch, setStitch] = useState(false);
  const profile = config?.profiles.find(profile => profile.id === profileId);
  const instants = scheduleInstants(date, timezone), instant = instants.length === 1 ? instants[0] : instants.includes(fold) ? fold : '';
  const chosen = channels.find(channel => channel.id === channelId), matching = channels.filter(channel => platformForChannel(channel.identifier) === platform);
  const current = draft ? { ...draft, hashtags: tags.trim().split(/\s+/u).filter(Boolean) } : undefined;
  const content = current ? postContent(current) : '', limit = contentLimit(platform);
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
    const abort = new AbortController(); setDraft(undefined); setChannelId(''); setPrivacy(''); setError('');
    void apiRequest<PostDraft>(`/api/publishing/jobs/${job.id}/draft?platform=${platform}`, { signal: abort.signal }).then(data => {
      if (abort.signal.aborted) return; setDraft(data); setTags(data.hashtags.join(' ')); dirty.current = false;
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
  const schedule = async () => {
    if (!job || !current || !chosen || !instant) return;
    await saveCopy();
    let settings: ProviderSettings;
    if (platform === 'tiktok') settings = { __type: 'tiktok', title: current.title, privacy_level: privacy as 'PUBLIC_TO_EVERYONE',
      duet, stitch, comment: comments, autoAddMusic: 'no', brand_content_toggle: partnership, brand_organic_toggle: ownBrand, video_made_with_ai: aiVideo, content_posting_method: 'DIRECT_POST' };
    else if (platform === 'youtube') settings = { __type: 'youtube', title: current.title, type: youtubeVisibility, selfDeclaredMadeForKids: kids, tags: current.hashtags.map(tag => ({ value: tag.slice(1), label: tag.slice(1) })) };
    else settings = { __type: chosen.identifier as 'instagram' | 'instagram-standalone', post_type: 'post', is_trial_reel: false, collaborators: [] };
    const payload = { channelId, content, date: instant, timezone, settings }, signature = JSON.stringify(payload);
    if (requestKey.current?.payload !== signature) requestKey.current = { payload: signature, id: crypto.randomUUID() };
    try {
      const result = await apiRequest<{ publication: Publication; job: RenderJob }>(`/api/publishing/jobs/${job.id}/schedule`, json({ ...payload, requestId: requestKey.current.id }));
      onJobSaved(result.job);
      await loadPublications(); setTab('queue');
      if (result.publication.state === 'failed') requestKey.current = null;
      setNotice(result.publication.state === 'scheduled' ? 'Scheduled in Postiz. The export is kept; you can close Remix Studio.' : 'Check the saved post status below.');
    } catch (error) {
      const entries = await loadPublications().catch(() => []);
      if (entries.find(entry => entry.id === requestKey.current?.id)?.state === 'failed') requestKey.current = null;
      throw error;
    }
  };
  const upsertProfile = (saved: PromotionProfile) => { setConfig(value => value && ({ ...value, profiles: [saved, ...value.profiles.filter(profile => profile.id !== saved.id)] })); setProfileId(saved.id); setEditingProfile(null); setNotice('App profile saved.'); };
  return <dialog ref={dialog} className="publishing-dialog" aria-labelledby="publishing-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><small>APP PROMOTION</small><h2 id="publishing-title">{job ? exportTitle(job) : 'App profiles & scheduled posts'}</h2></div><button type="button" aria-label="Close publishing" className="icon-button" disabled={!!busy} onClick={close}><X size={20} /></button></header>
    <nav aria-label="Publishing steps">{job && <><button aria-current={tab === 'copy' ? 'step' : undefined} disabled={!!busy} onClick={() => setTab('copy')}>1 · Post copy</button><button aria-current={tab === 'schedule' ? 'step' : undefined} disabled={!!busy || !draft} onClick={() => setTab('schedule')}>2 · Schedule</button></>}<button aria-current={tab === 'queue' ? 'step' : undefined} disabled={!!busy} onClick={() => setTab('queue')}>Scheduled posts</button></nav>
    <div className="publishing-body">
      {error && <p className="publishing-error" role="alert">{error}</p>}{notice && <p className="publishing-notice" role="status">{notice}</p>}
      {busy && <p role="status">{busy}{busy.startsWith('Uploading') ? ' Keep this window open until Postiz confirms the schedule.' : ''}</p>}
      {config && <details className="publishing-profiles" open={editingProfile !== null || (!config.profiles.length && tab === 'copy')}>
        <summary>App profiles · {profile?.name || 'Set your app, audience and market'}</summary>
        <div className="publishing-row"><label>Mobile app<select value={profileId} disabled={!!busy || !!editingProfile} onChange={e => setProfileId(e.target.value)}><option value="">Choose an app</option>{config.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.country}</option>)}</select></label>
          <button className="secondary-button" disabled={!!busy || !!editingProfile} onClick={() => setEditingProfile('new')}>Add app</button>{profile && <button className="secondary-button" disabled={!!busy || !!editingProfile} onClick={() => setEditingProfile(profile)}>Edit app</button>}</div>
        {editingProfile && <PromotionProfileEditor key={editingProfile === 'new' ? 'new' : editingProfile.id} profile={editingProfile === 'new' ? undefined : editingProfile} onSaved={upsertProfile} onCancel={() => setEditingProfile(null)} />}
      </details>}
      {job && tab !== 'queue' && <div className="publishing-row"><label>Platform<select value={platform} disabled={!!busy || !!editingProfile} onChange={e => { if (dirty.current) { setNotice('Save the current caption before switching platforms.'); return; } setPlatform(e.target.value as PostPlatform); }}><option value="tiktok">TikTok</option><option value="instagram">Instagram Reels</option><option value="youtube">YouTube</option></select></label>{profile && <span>{profile.language} · {profile.country}</span>}</div>}
      {tab === 'copy' && job && draft && <section aria-label="Post copy">
        <div className="publishing-actions"><button className="primary-button" disabled={!!busy || !profile || !!editingProfile} onClick={() => void run(config?.aiConfigured ? 'Writing two captions…' : 'Preparing hook…', async () => {
          const result = await apiRequest<PostDraft>(`/api/publishing/jobs/${job.id}/generate`, json({ platform, profileId })); setDraft(result); setTags(result.hashtags.join(' ')); dirty.current = false;
        })}><Sparkles size={15} />{config?.aiConfigured ? 'Generate short & long · DeepSeek' : 'Use hook & app hashtags'}</button></div>
        <p className="publishing-note">{config?.aiConfigured ? 'Uses the app profile and this export’s saved text. DeepSeek usage is billed by your API provider.' : 'DeepSeek is unavailable. The hook is used as a starting point; you can write and save your own caption.'}</p>
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
        <div className="publishing-actions"><button className="secondary-button" disabled={!!busy} onClick={() => void run('Saving copy…', async () => { await saveCopy(); setNotice('Post copy saved.'); })}>Save copy</button><button className="primary-button" disabled={!!busy} onClick={() => void run('Saving copy…', async () => { await saveCopy(); setTab('schedule'); })}>Continue to schedule</button></div>
      </section>}
      {tab === 'schedule' && job && draft && <section aria-label="Schedule this export">
        {!config?.configured ? <p>Add your Postiz API key to the server configuration to enable scheduling.</p> : <>
          <div className="publishing-row"><label>Postiz account<select aria-label="Postiz account" value={channelId} disabled={!!busy} onChange={e => { setChannelId(e.target.value); setPrivacy(''); }}><option value="">Choose an account</option>{matching.map(channel => <option key={channel.id} value={channel.id} disabled={channel.disabled}>{channel.name}{channel.profile ? ` · ${channel.profile}` : ''}{channel.disabled ? ' · reconnect in Postiz' : ''}</option>)}</select></label><button className="secondary-button" disabled={!!busy} onClick={() => void run('Refreshing accounts…', loadChannels)}>Refresh accounts</button></div>
          {channelError && <p className="publishing-error">{channelError}</p>}
          {!matching.length && <p>No {PLATFORM_NAMES[platform]} account is connected. <a href={config.dashboard} target="_blank" rel="noreferrer">Connect an account in Postiz</a>, then refresh.</p>}
          <fieldset disabled={!!busy}>
            <div className="publishing-row"><label>Publication date &amp; time<input type="datetime-local" value={date} onChange={e => { setDate(e.target.value); setFold(''); }} /></label><label>Time zone<input list="publishing-timezones" value={timezone} onChange={e => { setTimezone(e.target.value); setFold(''); }} /><datalist id="publishing-timezones">{['Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist></label></div>
            {date && !instants.length && <p role="alert">This local time or time zone is invalid, or the clock skips this time. Choose another time.</p>}
            {instants.length > 1 && <label>This time occurs twice — choose the instant<select value={fold} onChange={e => setFold(e.target.value)}><option value="">Choose an occurrence</option>{instants.map(value => <option key={value} value={value}>{new Date(value).toLocaleString('en-GB', { timeZone: timezone, timeZoneName: 'shortOffset' })}</option>)}</select></label>}
            {platform === 'tiktok' && <><label>TikTok visibility<select value={privacy} onChange={e => setPrivacy(e.target.value)}><option value="">Choose visibility</option><option value="PUBLIC_TO_EVERYONE">Everyone</option><option value="MUTUAL_FOLLOW_FRIENDS">Mutual followers</option><option value="FOLLOWER_OF_CREATOR">Followers</option><option value="SELF_ONLY">Only me</option></select></label><div className="publishing-checks">{[[ownBrand, setOwnBrand, 'Promotes my own app / brand'], [partnership, setPartnership, 'Paid partnership with another brand'], [aiVideo, setAiVideo, 'Video contains AI-generated content'], [comments, setComments, 'Allow comments'], [duet, setDuet, 'Allow duets'], [stitch, setStitch, 'Allow stitches']].map(([checked, setter, label]) => <label key={String(label)}><input type="checkbox" checked={checked as boolean} onChange={e => (setter as (value: boolean) => void)(e.target.checked)} />{label as string}</label>)}</div></>}
            {platform === 'youtube' && <div className="publishing-row"><label>YouTube visibility<select value={youtubeVisibility} onChange={e => setYoutubeVisibility(e.target.value as typeof youtubeVisibility)}><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></label><label>Made for kids?<select value={kids} onChange={e => setKids(e.target.value as typeof kids)}><option value="no">No</option><option value="yes">Yes</option></select></label></div>}
          </fieldset>
          <div className="publishing-confirmation"><video src={`/api/jobs/${job.id}/video`} controls preload="metadata" playsInline /><div><strong>{draft.title}</strong><p className="publication-content">{content}</p><p className={[...content].length > limit ? 'publishing-error' : 'publishing-note'}>{[...content].length} / {limit} characters · {draft.selected} version</p>{instant && <p>{new Date(instant).toLocaleString(undefined, { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })} · {timezone}</p>}</div></div>
          <p className="publishing-note">Scheduling uploads this MP4 to Postiz and keeps the local export. Postiz handles publication at the selected time. Platform settings may restrict what your connected account can publish.</p>
          <button className="primary-button" disabled={!!busy || !chosen || chosen.disabled || !instant || Date.parse(instant) < Date.now() + 120000 || !content.trim() || [...content].length > limit || (platform === 'tiktok' && !privacy)} onClick={() => void run('Uploading video and scheduling…', schedule)}><CalendarDays size={16} />Schedule on {PLATFORM_NAMES[platform]}</button>
        </>}
      </section>}
      {tab === 'queue' && <><div className="publishing-row"><h3>{job ? 'Posts for this export' : 'Scheduled posts'}</h3><button className="secondary-button" disabled={!!busy} onClick={() => void run('Loading saved posts…', async () => { await loadPublications(); })}>Reload list</button></div><PublicationList publications={publications} dashboard={config?.dashboard || 'https://platform.postiz.com'} onUpdated={updated => setPublications(entries => entries.map(entry => entry.id === updated.id ? updated : entry))} />{publications.length < publicationTotal && <button className="secondary-button" disabled={!!busy} onClick={() => void run('Loading older posts…', async () => { await loadPublications(true); })}>Load older posts · {publications.length} of {publicationTotal}</button>}</>}
      {dirty.current && <button type="button" className="publishing-discard" disabled={!!busy} onClick={onClose}>Discard unsaved copy changes &amp; close</button>}
    </div>
  </dialog>;
}
