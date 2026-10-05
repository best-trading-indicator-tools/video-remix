import { useEffect, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { contentLimit, PLATFORM_NAMES, platformForChannel, postContent, providerSettingsSchema, scheduleInstants,
  type CrossPostResult, type PostDraft, type PostizChannel, type PostPlatform, type ProviderSettings, type Publication, type ScheduleRequest } from '../shared/publishing';
import { apiRequest } from './api-client';

const platforms: PostPlatform[] = ['instagram', 'tiktok', 'youtube'];
type Copy = { title: string; content: string; tags: string; edited: boolean };
const copyFrom = (draft: PostDraft): Copy => ({ title: draft.title, content: postContent(draft), tags: draft.hashtags.map(tag => tag.slice(1)).join(', '), edited: false });
const labels: Partial<Record<Publication['state'], string>> = { scheduled: 'Scheduled', published: 'Published', failed: 'Needs attention', uncertain: 'Check in Postiz', uploading: 'Sending', submitting: 'Sending', draft: 'Draft in Postiz', cancelled: 'Cancelled' };

export default function CrossPostScheduler({ job, seed, channels, publications, configured, dashboard, channelError, disabled, visible, onRefresh, onBusy, onFinished, onViewPosts }: {
  job: RenderJob; seed: PostDraft; channels: PostizChannel[]; publications: Publication[]; configured: boolean; dashboard: string; channelError: string; disabled: boolean; visible: boolean;
  onRefresh: () => void; onBusy: (busy: boolean) => void; onFinished: (job: RenderJob) => Promise<void>; onViewPosts: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]), [copies, setCopies] = useState<Record<PostPlatform, Copy>>(() => ({ instagram: copyFrom(seed), tiktok: copyFrom(seed), youtube: copyFrom(seed) }));
  const [date, setDate] = useState(''), [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone), [fold, setFold] = useState('');
  const [privacy, setPrivacy] = useState(''), [youtubeVisibility, setYoutubeVisibility] = useState<'public' | 'unlisted' | 'private'>('public'), [kids, setKids] = useState<'yes' | 'no'>('no');
  const [ownBrand, setOwnBrand] = useState(true), [partnership, setPartnership] = useState(false), [aiVideo, setAiVideo] = useState(false);
  const [comments, setComments] = useState(true), [duet, setDuet] = useState(false), [stitch, setStitch] = useState(false);
  const [sending, setSending] = useState(false), [error, setError] = useState(''), [results, setResults] = useState<CrossPostResult[]>([]);
  const attempts = useRef(new Map<string, { signature: string; requestId: string }>());
  const locked = disabled || sending;
  const chosen = channels.filter(channel => selected.includes(channel.id) && !channel.disabled);
  const enabled = channels.filter(channel => !channel.disabled);
  const usedPlatforms = platforms.filter(platform => chosen.some(channel => platformForChannel(channel.identifier) === platform));
  const instants = scheduleInstants(date, timezone), instant = instants.length === 1 ? instants[0] : instants.includes(fold) ? fold : '';
  const seedContent = postContent(seed), seedTags = seed.hashtags.join(',');
  useEffect(() => { setCopies(current => Object.fromEntries(platforms.map(platform => [platform, current[platform].edited ? current[platform] : copyFrom(seed)])) as Record<PostPlatform, Copy>); }, [seed.title, seedContent, seedTags]);
  useEffect(() => { setResults(current => current.map(result => {
    const publication = publications.find(entry => entry.id === result.publication?.id);
    return publication ? { ...result, publication, message: publication.statusMessage } : result;
  })); }, [publications]);
  const editCopy = (platform: PostPlatform, patch: Partial<Copy>) => setCopies(current => ({ ...current, [platform]: { ...current[platform], ...patch, edited: true } }));
  const settingsFor = (channel: PostizChannel): ProviderSettings => {
    const platform = platformForChannel(channel.identifier)!, copy = copies[platform];
    if (platform === 'tiktok') return { __type: 'tiktok', title: copy.title, privacy_level: privacy as 'PUBLIC_TO_EVERYONE', duet, stitch, comment: comments,
      autoAddMusic: 'no', brand_content_toggle: partnership, brand_organic_toggle: ownBrand, video_made_with_ai: aiVideo, content_posting_method: 'DIRECT_POST' };
    if (platform === 'youtube') return { __type: 'youtube', title: copy.title, type: youtubeVisibility, selfDeclaredMadeForKids: kids,
      tags: copy.tags.split(',').map(tag => tag.trim()).filter(Boolean).map(tag => ({ value: tag, label: tag })) };
    return { __type: channel.identifier as 'instagram' | 'instagram-standalone', post_type: 'post', is_trial_reel: false, collaborators: [] };
  };
  const payloadFor = (channel: PostizChannel) => ({ channelId: channel.id, content: copies[platformForChannel(channel.identifier)!].content.trim(), date: instant, timezone, settings: settingsFor(channel) });
  const pending = chosen.filter(channel => {
    const attempt = attempts.current.get(channel.id), result = results.find(item => item.channelId === channel.id);
    return !attempt || attempt.signature !== JSON.stringify(payloadFor(channel)) || !result?.publication || ['failed', 'cancelled'].includes(result.publication.state);
  });
  const allScheduled = chosen.every(channel => ['scheduled', 'published'].includes(results.find(result => result.channelId === channel.id)?.publication?.state || ''));
  const issues = usedPlatforms.flatMap(platform => {
    const copy = copies[platform], messages: string[] = [];
    if (!copy.content.trim()) messages.push(`${PLATFORM_NAMES[platform]} needs a caption.`);
    if ([...copy.content.trim()].length > contentLimit(platform)) messages.push(`${PLATFORM_NAMES[platform]} caption is too long.`);
    const settings = providerSettingsSchema.safeParse(settingsFor(chosen.find(channel => platformForChannel(channel.identifier) === platform)!));
    if (!settings.success) messages.push(platform === 'tiktok' && !privacy ? 'Choose TikTok visibility.' : `${PLATFORM_NAMES[platform]}: ${settings.error.issues[0].message}`);
    return messages;
  });
  const validTime = !!instant && Date.parse(instant) >= Date.now() + 120000 && Date.parse(instant) <= Date.now() + 366 * 86400000;
  const submit = async () => {
    if (locked || !validTime || issues.length || !pending.length || chosen.length > 50) return;
    setSending(true); onBusy(true); setError('');
    const requests: ScheduleRequest[] = pending.map(channel => {
      const payload = payloadFor(channel), signature = JSON.stringify(payload), previous = attempts.current.get(channel.id);
      const knownFailed = ['failed', 'cancelled'].includes(results.find(item => item.channelId === channel.id)?.publication?.state || '');
      const requestId = previous?.signature === signature && !knownFailed ? previous.requestId : crypto.randomUUID();
      attempts.current.set(channel.id, { signature, requestId });
      return { ...payload, requestId };
    });
    try {
      const data = await apiRequest<{ results: CrossPostResult[]; job: RenderJob }>(`/api/publishing/jobs/${job.id}/schedule-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }),
      });
      setResults(current => [...current.filter(item => !data.results.some(result => result.channelId === item.channelId)), ...data.results]);
      await onFinished(data.job);
    } catch (error) {
      setError(`${(error as Error).message} Retry keeps the same request IDs so confirmed posts are not duplicated. You can also check Scheduled posts.`);
      // The server may have completed some accounts even if the browser lost the response.
      try {
        const saved = await apiRequest<{ publications: Publication[] }>(`/api/publishing/publications?jobId=${encodeURIComponent(job.id)}`);
        const found = saved.publications.filter(entry => requests.some(request => request.requestId === entry.id));
        setResults(current => [...current.filter(item => !found.some(entry => entry.request.channelId === item.channelId)), ...found.map(publication => ({ channelId: publication.request.channelId, publication }))]);
      } catch { /* Keep request IDs for a safe retry when the connection returns. */ }
    } finally { setSending(false); onBusy(false); }
  };
  return <section aria-label="Cross-post this export" hidden={!visible}>
    <h3>Choose accounts</h3>
    <p>Send this export to several accounts at once, including multiple accounts on the same platform.</p>
    {!configured ? <p>Add your Postiz API key to the server configuration to enable scheduling.</p> : <>
      <div className="publishing-actions"><button type="button" className="secondary-button" disabled={locked || !enabled.length} onClick={() => setSelected(enabled.every(channel => selected.includes(channel.id)) ? [] : enabled.map(channel => channel.id))}>{enabled.length && enabled.every(channel => selected.includes(channel.id)) ? 'Clear selection' : 'Select all accounts'}</button><button type="button" className="secondary-button" disabled={locked} onClick={onRefresh}>Refresh accounts</button><a href={dashboard} target="_blank" rel="noreferrer">Connect accounts in Postiz</a></div>
      {channelError && <p className="publishing-error" role="alert">{channelError}</p>}
      <div className="cross-post-accounts">{platforms.map(platform => {
        const group = channels.filter(channel => platformForChannel(channel.identifier) === platform), active = group.filter(channel => !channel.disabled);
        return <fieldset key={platform} disabled={locked}><legend>{PLATFORM_NAMES[platform]} <span>{group.filter(channel => selected.includes(channel.id) && !channel.disabled).length} selected</span></legend>
          {!group.length && <p className="publishing-note">No connected accounts.</p>}
          {active.length > 1 && <button type="button" className="cross-post-select" onClick={() => setSelected(current => active.every(channel => current.includes(channel.id)) ? current.filter(id => !active.some(channel => channel.id === id)) : [...new Set([...current, ...active.map(channel => channel.id)])])}>Select / clear all {PLATFORM_NAMES[platform]}</button>}
          {group.map(channel => <label className="cross-post-account" key={channel.id}><input type="checkbox" checked={selected.includes(channel.id)} disabled={channel.disabled} onChange={event => setSelected(current => event.target.checked ? [...current, channel.id] : current.filter(id => id !== channel.id))} /><span><strong>{channel.name}</strong>{channel.profile && <small>{channel.profile}</small>}{channel.disabled && <small>Reconnect in Postiz</small>}</span></label>)}
        </fieldset>;
      })}</div>
      <p role="status">{chosen.length} account{chosen.length === 1 ? '' : 's'} selected{chosen.length ? ` across ${usedPlatforms.length} platform${usedPlatforms.length === 1 ? '' : 's'}` : ''}.</p>
      {chosen.length > 50 && <p className="publishing-error">Select up to 50 accounts per batch.</p>}
      {!!chosen.length && <>
        <h3>Review captions &amp; settings</h3><p className="publishing-note">Each platform starts with your current caption. Adjust it below; all selected accounts on that platform use this version.</p>
        <div className="cross-post-copy">{usedPlatforms.map(platform => <fieldset key={platform} disabled={locked}><legend>{PLATFORM_NAMES[platform]} · {chosen.filter(channel => platformForChannel(channel.identifier) === platform).length} accounts</legend>
          {platform !== 'instagram' && <label>{PLATFORM_NAMES[platform]} title<input value={copies[platform].title} maxLength={platform === 'tiktok' ? 90 : 100} onChange={event => editCopy(platform, { title: event.target.value })} /></label>}
          <label>{PLATFORM_NAMES[platform]} caption &amp; hashtags<textarea rows={5} maxLength={5000} value={copies[platform].content} onChange={event => editCopy(platform, { content: event.target.value })} /></label>
          <p className={[...copies[platform].content.trim()].length > contentLimit(platform) ? 'publishing-error' : 'publishing-note'}>{[...copies[platform].content.trim()].length} / {contentLimit(platform)} characters</p>
          {platform === 'tiktok' && <><label>TikTok visibility<select value={privacy} onChange={event => setPrivacy(event.target.value)}><option value="">Choose visibility</option><option value="PUBLIC_TO_EVERYONE">Everyone</option><option value="MUTUAL_FOLLOW_FRIENDS">Mutual followers</option><option value="FOLLOWER_OF_CREATOR">Followers</option><option value="SELF_ONLY">Only me</option></select></label><div className="publishing-checks">{[[ownBrand, setOwnBrand, 'Promotes my own app / brand'], [partnership, setPartnership, 'Paid partnership with another brand'], [aiVideo, setAiVideo, 'Video contains AI-generated content'], [comments, setComments, 'Allow comments'], [duet, setDuet, 'Allow duets'], [stitch, setStitch, 'Allow stitches']].map(([checked, setter, label]) => <label key={String(label)}><input type="checkbox" checked={checked as boolean} onChange={event => (setter as (value: boolean) => void)(event.target.checked)} />{label as string}</label>)}</div></>}
          {platform === 'youtube' && <><div className="publishing-row"><label>YouTube visibility<select value={youtubeVisibility} onChange={event => setYoutubeVisibility(event.target.value as typeof youtubeVisibility)}><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></label><label>Made for kids?<select value={kids} onChange={event => setKids(event.target.value as typeof kids)}><option value="no">No</option><option value="yes">Yes</option></select></label></div><label>YouTube tags — comma-separated<input value={copies.youtube.tags} onChange={event => editCopy('youtube', { tags: event.target.value })} /></label></>}
        </fieldset>)}</div>
        <h3>When to publish</h3>
        <fieldset disabled={locked}><div className="publishing-row"><label>Publication date &amp; time<input type="datetime-local" value={date} onChange={event => { setDate(event.target.value); setFold(''); }} /></label><label>Time zone<input list="cross-post-timezones" value={timezone} onChange={event => { setTimezone(event.target.value); setFold(''); }} /><datalist id="cross-post-timezones">{['Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist></label></div>
          {date && !instants.length && <p role="alert" className="publishing-error">This local time or time zone is invalid, or the clock skips this time. Choose another time.</p>}
          {instants.length > 1 && <label>This time occurs twice — choose the instant<select value={fold} onChange={event => setFold(event.target.value)}><option value="">Choose an occurrence</option>{instants.map(value => <option key={value} value={value}>{new Date(value).toLocaleString('en-GB', { timeZone: timezone, timeZoneName: 'shortOffset' })}</option>)}</select></label>}
          {instant && <p className="publishing-note">All selected accounts: {new Date(instant).toLocaleString(undefined, { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })} · {timezone}</p>}
          {instant && !validTime && <p className="publishing-error">Choose a time at least two minutes ahead and within the next year.</p>}
        </fieldset>
        <div className="publishing-confirmation"><video src={`/api/jobs/${job.id}/video`} controls preload="metadata" playsInline /><div><strong>{seed.title}</strong><p>{chosen.map(channel => `${PLATFORM_NAMES[platformForChannel(channel.identifier)!]} · ${channel.name}`).join('\n')}</p><p className="publishing-note">The video is uploaded once. Each account gets its own scheduled post and status. The local export is kept automatically.</p></div></div>
        {!!issues.length && <p className="publishing-error">{issues.join(' ')}</p>}
        <button type="button" className="primary-button" disabled={locked || !validTime || !!issues.length || !pending.length || chosen.length > 50} onClick={() => void submit()}><CalendarDays size={16} />{sending ? 'Scheduling accounts…' : results.length && !pending.length ? allScheduled ? 'All selected accounts scheduled' : 'Check account results' : results.length ? `Schedule ${pending.length} remaining account${pending.length === 1 ? '' : 's'}` : `Schedule to ${chosen.length} account${chosen.length === 1 ? '' : 's'}`}</button>
      </>}
      {error && <p className="publishing-error" role="alert">{error}</p>}
      {!!results.length && <section className="cross-post-results" aria-label="Scheduling results"><h3>Account results</h3>{results.map(result => <p key={result.channelId}><strong>{channels.find(channel => channel.id === result.channelId)?.name || result.channelId}</strong> · {result.publication ? labels[result.publication.state] || result.publication.state : 'Needs attention'}{(result.message || result.publication?.statusMessage) && <span className="publishing-error"> — {result.message || result.publication?.statusMessage}</span>}</p>)}<button type="button" className="secondary-button" disabled={locked} onClick={onViewPosts}>View scheduled posts &amp; resolve issues</button></section>}
    </>}
  </section>;
}
