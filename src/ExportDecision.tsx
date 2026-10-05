import { useState } from 'react';
import { REVIEW_LABELS, reviewStatus } from '../shared/library';
import type { ExportReview, RenderJob } from '../shared/types';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export default function ExportDecision({ job, onSaved }: { job: RenderJob; onSaved: (job: RenderJob) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const status = reviewStatus(job.review);
  return <div className={`export-decision decision-${status}`}>
    <label>Review decision<select aria-label={`Review decision for ${job.exportName || job.summary?.title || job.sourceName}`} disabled={busy} value={status} onChange={async event => {
      const next = event.target.value;
      setBusy(true); setError('');
      try {
        const review = await apiRequest<ExportReview>(`/api/jobs/${job.id}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verdict: next === 'unreviewed' ? null : next === 'accepted' ? job.parentJobId ? 'accepted-after-correction' : 'accepted-unchanged' : next }) });
        onSaved({ ...job, review });
      } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>{Object.entries(REVIEW_LABELS).filter(([id]) => id !== 'all').map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    {error && <ProblemNotice message={error} operation="Save export review" entityId={job.id} />}
  </div>;
}
