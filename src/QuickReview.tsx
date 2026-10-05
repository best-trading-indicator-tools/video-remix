import { useEffect, useRef, useState } from 'react';
import type { ExportReview, RenderJob } from '../shared/types';
import { exportStatus, exportTitle } from '../shared/export-presentation';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';
import './export-review.css';

export default function QuickReview({ jobs, paused, onClose, onEdit, onSaved }: { jobs: RenderJob[]; paused: boolean; onClose: () => void; onEdit: (job: RenderJob) => void; onSaved: (id: string, review: ExportReview) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null), busyRef = useRef(false);
  const [index, setIndex] = useState(0), [notes, setNotes] = useState(''), [originalNotes, setOriginalNotes] = useState('');
  const [review, setReview] = useState<ExportReview>({}), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [advance, setAdvance] = useState(false), [reload, setReload] = useState(0);
  const job = jobs[index];
  useEffect(() => { const element = dialog.current!; if (!paused) { element.showModal(); void video.current?.play().catch(() => {}); } else { element.close(); video.current?.pause(); } return () => element.close(); }, [paused]);
  useEffect(() => {
    if (!job) return;
    const controller = new AbortController(); setLoaded(false); setNotes(''); setOriginalNotes(''); setReview({}); setError('');
    void apiRequest<{ review: ExportReview }>(`/api/jobs/${job.id}/review`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setReview(data.review); setNotes(data.review.notes ?? ''); setOriginalNotes(data.review.notes ?? ''); setLoaded(true); }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [job?.id, reload]);
  const save = async (verdict?: ExportReview['verdict']) => {
    if (!job || !loaded || busyRef.current) return false;
    if (!verdict && notes === originalNotes) return true;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const updated = await apiRequest<ExportReview>(`/api/jobs/${job.id}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(verdict ? { verdict } : {}), notes }) });
      setReview(updated); setOriginalNotes(notes); onSaved(job.id, updated); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const move = async (direction: number, verdict?: ExportReview['verdict']) => { if (await save(verdict)) { video.current?.pause(); setIndex(value => Math.max(0, Math.min(jobs.length, value + direction))); } };
  const close = async () => { if ((!loaded && !notes) || !job || await save()) onClose(); };
  const edit = async () => { if (job.editable && await save('needs-edit')) { video.current?.pause(); onEdit(job); } };
  const accept = () => void move(1, job.parentJobId ? 'accepted-after-correction' : 'accepted-unchanged');
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (paused || !dialog.current?.open || event.altKey || event.ctrlKey || event.metaKey || event.repeat || (event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!job || !loaded || busyRef.current) return;
      const key = event.key.toLowerCase();
      if (!['a', 'e', 'r', 'arrowleft', 'arrowright'].includes(key)) return;
      event.preventDefault();
      if (key === 'a') accept(); else if (key === 'e') void edit(); else if (key === 'r') void move(1, 'rejected'); else void move(key === 'arrowleft' ? -1 : 1);
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });
  return <dialog ref={dialog} className="quick-review" aria-labelledby="quick-review-title" onCancel={event => { event.preventDefault(); void close(); }}>
    <header><div><small>QUICK REVIEW · {Math.min(index + 1, jobs.length)} / {jobs.length}</small><h2 id="quick-review-title">{job ? exportTitle(job) : 'Review complete'}</h2></div><button type="button" onClick={() => void close()} disabled={busy}>Close · Esc</button></header>
    {job ? <div className="quick-review-body"><div className="quick-review-screen"><video key={job.id} ref={video} src={`/api/jobs/${job.id}/video`} poster={`/api/jobs/${job.id}/thumbnail`} controls playsInline autoPlay={!paused} onEnded={() => { if (advance) void move(1); }} /></div>
      <aside><span className={`export-verdict ${exportStatus(job).kind}`}>{exportStatus(job).label}</span>
        <p>{review.verdict ? { 'accepted-unchanged': 'Accepted unchanged', 'accepted-after-correction': 'Accepted after correction', rejected: 'Rejected', 'needs-edit': 'Needs edits' }[review.verdict] : 'No decision yet'}</p>
        <label>Review notes<textarea rows={5} maxLength={500} value={notes} disabled={!loaded || busy} onChange={event => setNotes(event.target.value)} placeholder="What worked? What needs changing?" /></label>
        <div className="quick-review-decisions"><button disabled={!loaded || busy} onClick={accept}><kbd>A</kbd> Accept</button><button disabled={!loaded || busy || !job.editable} onClick={() => void edit()}><kbd>E</kbd> Edit</button><button disabled={!loaded || busy} onClick={() => void move(1, 'rejected')}><kbd>R</kbd> Reject</button></div>
        <p>Decisions and notes are saved in History. Rejected exports remain available.</p>
        <label className="quick-review-auto"><input type="checkbox" checked={advance} onChange={event => setAdvance(event.target.checked)} />Play the next export when this one ends</label>
        <div className="quick-review-navigation"><button disabled={!loaded || busy || index === 0} onClick={() => void move(-1)}>← Previous</button><button disabled={!loaded || busy} onClick={() => void move(1)}>Next →</button></div>
        {busy && <p role="status">Saving review…</p>}{error && <><ProblemNotice message={error} operation="Save export review" /><button onClick={() => setReload(value => value + 1)}>Reload review</button></>}
      </aside></div> : <div className="quick-review-complete"><p>You’ve reached the end of this collection. Your decisions and notes are saved in History.</p><button onClick={() => setIndex(0)}>Review again</button><button onClick={onClose}>Done</button></div>}
  </dialog>;
}
