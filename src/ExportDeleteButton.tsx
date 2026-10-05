import { useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export default function ExportDeleteButton({ job, onDeleted }: { job: RenderJob; onDeleted: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="export-delete-control" onKeyDown={event => {
    if (event.key === 'Escape' && confirming && !busy) { event.stopPropagation(); setConfirming(false); }
  }}>
    {!confirming ? <button type="button" className="secondary-button" onClick={() => { setError(''); setConfirming(true); }}>
      <Trash2 size={14} />Delete export
    </button> : <div className="export-delete-confirm" role="alert">
      <p>Delete this export and its editing files?{job.keptAt && ' This also removes its kept copy.'}{job.draftSavedAt && ' Its saved editing draft will be deleted too.'} This cannot be undone.</p>
      <p>Original videos, History, and scheduled posts stay intact.</p>
      <div><button type="button" className="secondary-button" autoFocus disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try {
            await apiRequest(`/api/jobs/${job.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
            onDeleted(job.id);
          } catch (error) { setError(error instanceof Error ? error.message : 'Could not delete this export. Try again.'); }
          finally { setBusy(false); }
        }}>{busy ? <><LoaderCircle size={14} className="spin" />Deleting…</> : 'Confirm delete'}</button>
      </div>
    </div>}
    {error && <ProblemNotice message={error} operation="Delete export" entityId={job.id} />}
  </div>;
}
