import { useState } from 'react';
import type { VideoSource } from '../shared/types';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export default function SourceProtection({ source, onSaved }: { source: VideoSource; onSaved: (source: VideoSource) => void }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!source.draftProtected) return null;
  return <details className="source-protection"><summary>Short-draft file protection</summary><p>This video is retained for saved short drafts. Remove completed drafts to release it.</p><p>If the drafts were lost after clearing browser data, you can release their protection here.</p>
    {!confirm ? <button className="secondary-button" onClick={() => setConfirm(true)}>Release protection…</button> : <div><p>Release protection for every browser’s short drafts using this video? It may expire immediately if no export uses it. Keep a related export to retain the video.</p><button className="secondary-button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="secondary-button" disabled={busy} onClick={async () => {
      setBusy(true); setError(''); try { onSaved(await apiRequest<VideoSource>(`/api/sources/${source.id}/draft-protection`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ release: true }) })); setConfirm(false); }
      catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
    }}>{busy ? 'Releasing…' : 'Release draft protection'}</button></div>}
    {error && <ProblemNotice message={error} operation="Release draft protection" />}
  </details>;
}
