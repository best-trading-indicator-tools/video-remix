import { useEffect, useRef, useState } from 'react';
import { Bookmark, Download, LoaderCircle, MonitorPlay, Trash2, X } from 'lucide-react';
import type { RenderJob } from '../shared/types';
import { MAX_EXPORT_SELECTION, retainExportSelection } from '../shared/export-selection';
import { exportTitle } from '../shared/export-presentation';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export function useExportSelection(available: RenderJob[]) {
  const [ids, setIds] = useState<string[]>([]);
  const availableKey = available.map(job => job.id).join('|');
  useEffect(() => {
    setIds(current => {
      const next = retainExportSelection(current, available);
      return next.length === current.length ? current : next;
    });
  }, [availableKey]);
  // Derive immediately as well: a filter or collapsing revisions must never leave
  // invisible exports actionable for a render while the effect catches up.
  const selectedIds = new Set(retainExportSelection(ids, available));
  const selected = available.filter(job => selectedIds.has(job.id));
  return {
    selected, selectedIds,
    clear: () => setIds([]),
    toggle: (id: string) => setIds(current => {
      const valid = retainExportSelection(current, available);
      return valid.includes(id) ? valid.filter(item => item !== id)
        : valid.length < MAX_EXPORT_SELECTION && available.some(job => job.id === id) ? [...valid, id] : valid;
    }),
    selectAll: (checked: boolean) => setIds(checked ? available.slice(0, MAX_EXPORT_SELECTION).map(job => job.id) : []),
  };
}

export default function ExportBulkActions({ available, selected, busy, onBusy, onSelectAll, onClear, onKept, onDeleted, onReview }: {
  available: RenderJob[]; selected: RenderJob[]; busy: boolean; onBusy: (value: boolean) => void;
  onSelectAll: (checked: boolean) => void; onClear: () => void;
  onKept: (jobs: RenderJob[]) => void; onDeleted: (ids: string[]) => void;
  onReview: (jobs: RenderJob[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'keep' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const allRef = useRef<HTMLInputElement>(null);
  const requestPending = useRef(false);
  const ids = selected.map(job => job.id), selectionKey = ids.join('|');
  const selectedSet = new Set(ids);
  const allShown = available.length > 0 && available.slice(0, MAX_EXPORT_SELECTION).every(job => selectedSet.has(job.id));
  const finished = selected.length > 0 && selected.every(job => job.status === 'completed');
  const kept = selected.filter(job => job.keptAt).length, drafts = selected.filter(job => job.draftSavedAt).length;
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = selected.length > 0 && !allShown; }, [selected.length, allShown]);
  useEffect(() => { setConfirming(false); setError(''); }, [selectionKey]);

  const run = async (action: 'keep' | 'delete') => {
    if (!ids.length || requestPending.current) return;
    requestPending.current = true; onBusy(true); setPending(action); setError(''); setNotice('');
    try {
      if (action === 'keep') {
        const result = await apiRequest<{ jobs: RenderJob[] }>('/api/exports/keep', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
        });
        onKept(result.jobs);
        setNotice(`${result.jobs.length} exports and their editing files are kept.`);
      } else {
        const result = await apiRequest<{ removedIds: string[]; cleanupFailedIds: string[] }>('/api/exports/selected', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, confirm: true }),
        });
        onDeleted(result.removedIds); onClear();
        setNotice(result.cleanupFailedIds.length
          ? `${result.removedIds.length} exports removed from the list. Files for ${result.cleanupFailedIds.length} exports could not be fully cleared from disk.`
          : `${result.removedIds.length} exports deleted. Original videos and History are kept.`);
      }
      setConfirming(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update the selected exports. Try again.'); }
    finally { requestPending.current = false; onBusy(false); setPending(null); }
  };

  return <div className={`export-selection${selected.length ? ' has-selection' : ''}`} aria-label="Bulk export actions"
    onKeyDown={event => { if (event.key === 'Escape' && confirming && !busy) { event.stopPropagation(); setConfirming(false); } }}>
    <div className="export-selection-bar">
      <label className="export-select-all"><input ref={allRef} type="checkbox" checked={allShown}
        disabled={busy || !available.length} onChange={event => { setNotice(''); onSelectAll(event.target.checked); }} />
        {available.length > MAX_EXPORT_SELECTION ? `Select first ${MAX_EXPORT_SELECTION} shown` : 'Select all shown'}
      </label>
      <strong role="status" className="export-selection-count">{selected.length} selected</strong>
      {selected.length > 0 && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setNotice(''); onClear(); }}><X size={14} />Clear selection</button>}
    </div>
    <p className="export-selection-help">Select exports across collections. Only visible cards are selected; rendering exports and collapsed revisions are excluded.{available.length > MAX_EXPORT_SELECTION && ` Up to ${MAX_EXPORT_SELECTION} exports at once.`}</p>
    {selected.length > 0 && <div className="export-selection-actions">
      <button type="button" className="secondary-button" disabled={busy || !finished || kept === selected.length} onClick={() => void run('keep')}>
        {pending === 'keep' ? <LoaderCircle size={15} className="spin" /> : <Bookmark size={15} />}{pending === 'keep' ? 'Keeping…' : kept === selected.length ? 'All selected are kept' : 'Keep selected'}
      </button>
      {finished && !busy ? <a className="secondary-button" download href={`/api/exports/selected.zip?ids=${encodeURIComponent(ids.join(','))}`}><Download size={15} />Download selected <span className="zip-tag">ZIP</span></a>
        : <button type="button" className="secondary-button" disabled><Download size={15} />Download selected <span className="zip-tag">ZIP</span></button>}
      <button type="button" className="secondary-button" disabled={busy || !finished} onClick={() => onReview([...selected])}><MonitorPlay size={15} />Review selected</button>
      <button type="button" className="secondary-button export-bulk-delete" disabled={busy || confirming} onClick={() => { setError(''); setNotice(''); setConfirming(true); }}><Trash2 size={15} />Delete selected</button>
    </div>}
    {selected.length > 0 && !finished && <p className="export-selection-help">Keep, download and review require finished exports. You can still delete this selection.</p>}
    {confirming && <div className="export-bulk-confirm" role="alert">
      <strong>Delete {selected.length} selected {selected.length === 1 ? 'export' : 'exports'}?</strong>
      <p>This permanently deletes their video files, captions and editing files.{kept > 0 && ` Includes ${kept} kept ${kept === 1 ? 'export' : 'exports'}.`}{drafts > 0 && ` Includes ${drafts} saved editing ${drafts === 1 ? 'draft' : 'drafts'}.`} This cannot be undone.</p>
      <ul aria-label="Exports to delete">{selected.map(job => <li key={job.id}>{exportTitle(job)} · V{job.variant}{job.parentJobId ? ` · Revision ${job.revision ?? 1}` : ''}</li>)}</ul>
      <p>Original videos, History, and scheduled posts stay intact.</p>
      <div className="export-selection-actions">
        <button type="button" className="secondary-button" autoFocus disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
        <button type="button" className="secondary-button export-bulk-delete" disabled={busy} onClick={() => void run('delete')}>
          {pending === 'delete' && <LoaderCircle size={15} className="spin" />}{pending === 'delete' ? 'Deleting…' : `Delete ${selected.length} ${selected.length === 1 ? 'export' : 'exports'} permanently`}
        </button>
      </div>
    </div>}
    {error && <ProblemNotice message={error} operation="Update selected exports" />}
    {notice && <p className="export-selection-notice" role="status">{notice}</p>}
  </div>;
}
