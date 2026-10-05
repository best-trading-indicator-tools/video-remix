import { useRef, useState } from 'react';
import { Pencil, Play } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { exportTitle } from '../shared/export-presentation';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';
import './export-review.css';

export function ExportPreview({ job, onOpen }: { job: RenderJob; onOpen: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const start = () => { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; const element = video.current; if (element) void element.play().then(() => setPlaying(true)).catch(() => {}); };
  const stop = () => { video.current?.pause(); setPlaying(false); };
  return <button type="button" className={`export-preview ${playing ? 'playing' : ''}`} onClick={onOpen} onPointerEnter={start} onPointerLeave={stop} onFocus={start} onBlur={stop} aria-label={`Preview ${exportTitle(job)}`}>
    <video ref={video} src={`/api/jobs/${job.id}/video`} poster={`/api/jobs/${job.id}/thumbnail`} muted loop playsInline preload="none" />
    <span><Play size={18} /></span>
  </button>;
}
export function ExportName({ job, onSaved }: { job: RenderJob; onSaved: (job: RenderJob) => void }) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!editing) return <><strong title={exportTitle(job)}>{exportTitle(job)}</strong><button type="button" className="export-rename" aria-label="Rename export" onClick={() => { setName(exportTitle(job)); setEditing(true); }}><Pencil size={12} /></button></>;
  return <form className="export-name-form" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { onSaved(await apiRequest<RenderJob>(`/api/jobs/${job.id}/title`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name }) })); setEditing(false); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}><input aria-label="Export title" autoFocus required maxLength={90} value={name} onChange={event => setName(event.target.value)} /><button disabled={busy}>Save</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>{error && <ProblemNotice message={error} operation="Rename export" />}</form>;
}
