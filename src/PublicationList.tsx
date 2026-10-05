import { useState } from 'react';
import { PLATFORM_NAMES, type Publication } from '../shared/publishing';
import { apiRequest } from './api-client';
const labels: Record<Publication['state'], string> = { uploading: 'Uploading video', submitting: 'Waiting for Postiz', scheduled: 'Scheduled', published: 'Published', failed: 'Needs attention', uncertain: 'Check in Postiz', cancelled: 'Cancelled', cancelling: 'Cancelling', draft: 'Draft in Postiz' };

export default function PublicationList({ publications, dashboard, onUpdated }: { publications: Publication[]; dashboard: string; onUpdated: (entry: Publication) => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const action = async (entry: Publication, operation: 'refresh' | 'cancel' | 'resolve') => {
    setBusy(entry.id); setError('');
    try { onUpdated(await apiRequest<Publication>(`/api/publishing/publications/${entry.id}${operation === 'cancel' ? '' : `/${operation}`}`, {
      method: operation === 'cancel' ? 'DELETE' : 'POST', ...(operation === 'resolve' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmedAbsentInPostiz: true }) } : {}),
    })); } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  };
  return <section className="publication-list" aria-label="Scheduled posts">
    {!publications.length && <p>No posts scheduled from this workspace yet.</p>}
    {publications.map(entry => <article key={entry.id}>
      <div className="publishing-row"><strong>{entry.exportTitle}</strong><span className={`publication-state ${entry.state}`}>{labels[entry.state]}</span></div>
      <p>{PLATFORM_NAMES[entry.platform]} · {entry.channelName || 'Checking account'}</p>
      <p><time dateTime={entry.request.date}>{new Date(entry.request.date).toLocaleString(undefined, { timeZone: entry.request.timezone, dateStyle: 'medium', timeStyle: 'short' })}</time> · {entry.request.timezone}</p>
      <details><summary>Post text &amp; settings</summary><p className="publication-content">{entry.request.content}</p><p>{entry.request.settings.__type === 'tiktok' ? `Visibility: ${entry.request.settings.privacy_level}` : entry.request.settings.__type === 'youtube' ? `Visibility: ${entry.request.settings.type}` : 'Instagram Reel'}</p></details>
      {entry.statusMessage && <p className="publishing-error">{entry.statusMessage}</p>}
      <div className="publishing-actions">
        {!['uploading', 'submitting', 'cancelling', 'cancelled'].includes(entry.state) && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void action(entry, 'refresh')}>{busy === entry.id ? 'Checking…' : 'Refresh status'}</button>}
        {entry.postId && ['scheduled', 'draft', 'failed'].includes(entry.state) && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void action(entry, 'cancel')}>Cancel scheduled post</button>}
        <a className="secondary-button" href={entry.releaseUrl || dashboard} target="_blank" rel="noreferrer">{entry.releaseUrl ? 'View published post' : 'Open Postiz'}</a>
      </div>
      {entry.state === 'uncertain' && <details><summary>Resolve after checking Postiz</summary><p>Only use this if you checked the calendar and this post does not exist. It allows another scheduling attempt.</p><button className="secondary-button" disabled={!!busy} onClick={() => void action(entry, 'resolve')}>I checked Postiz: this post does not exist</button></details>}
    </article>)}
    {error && <p role="alert" className="publishing-error">{error}</p>}
  </section>;
}
