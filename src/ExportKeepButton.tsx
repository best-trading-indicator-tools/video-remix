import { useState } from 'react';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export default function ExportKeepButton({ job, retentionHours, onSaved }: {
  job: RenderJob; retentionHours: number; onSaved: (job: RenderJob) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const kept = Boolean(job.keptAt);
  return <div className="export-keep-control">
    <button type="button" className="secondary-button export-keep-button" aria-pressed={kept} disabled={busy}
      title={kept ? `Kept in this workspace with its editing files. Click to release; automatic deletion resumes in ${retentionHours} hours.` : 'Keep this export and its editing files beyond automatic expiry.'}
      onClick={async () => {
        if (busy) return;
        setBusy(true); setError('');
        try {
          onSaved(await apiRequest<RenderJob>(`/api/jobs/${job.id}/keep`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keep: !kept }),
          }));
        } catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      }}>
      {kept ? <BookmarkCheck size={15} /> : <Bookmark size={15} />}{busy ? 'Saving…' : kept ? 'Kept' : 'Keep'}
    </button>
    {error && <ProblemNotice message={error} operation="Keep export" entityId={job.id} />}
  </div>;
}
