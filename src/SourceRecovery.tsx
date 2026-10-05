import { useState } from 'react';
import type { RenderJob, VideoSource } from '../shared/types';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export interface SourceStatus { available: boolean; name: string; canMatch: boolean; candidates: VideoSource[] }
export default function SourceRecovery({ job, initial, onRecovered, onImport }: {
  job: RenderJob; initial: SourceStatus; onRecovered: (job: RenderJob) => void; onImport: () => void;
}) {
  const [status, setStatus] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="source-recovery"><h3>Reconnect the original video</h3><p>The export is still available, but its original video is missing or has changed.</p><strong>{status.name}</strong>
    <p>{status.canMatch ? 'Import the unchanged original. We check its contents before reconnecting your saved cuts and captions.' : 'This older export has no source fingerprint. Its original cannot be verified automatically; import the source to create a new edit. Your export remains available.'}</p>
    <div className="library-actions"><button className="primary-button" disabled={busy} onClick={onImport}>Import original</button><button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
      const next = await apiRequest<SourceStatus>(`/api/jobs/${job.id}/source-status`); setStatus(next); if (next.available) onRecovered(job);
    })}>Check again</button></div>
    {status.candidates.map(source => <div key={source.id}><p>{source.name} · matching contents</p><button className="secondary-button" disabled={busy} onClick={() => void run(async () => {
      onRecovered(await apiRequest<RenderJob>(`/api/jobs/${job.id}/reconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: source.id }) }));
    })}>Reconnect this original</button></div>)}
    {error && <ProblemNotice message={error} operation="Reconnect original" />}
  </div>;
}
