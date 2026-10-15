import { useEffect, useRef, useState } from 'react';
import type { EditPlan } from '../shared/types';
import { apiRequest } from './api-client';

/** Source-picture sample for saved edits; saved narration and supporting shots remain in the full export. */
export default function EmbeddedCaptionPreview({ sourceId, plan, disabled }: { sourceId: string; plan: EditPlan; disabled?: boolean }) {
  const signature = JSON.stringify({ sourceId, settings: plan.settings, cuts: plan.cuts });
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    request.current?.abort(); request.current = null; setBusy(false); setUrl(''); setError('');
    return () => { request.current?.abort(); };
  }, [signature]);
  const render = async () => {
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try {
      const result = await apiRequest<{ url: string }>('/api/previews', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ sourceId, settings: { ...plan.settings, segments: plan.cuts, trimStart: 0, trimEnd: null, timeShift: 0, audioId: null, subtitleId: null } }),
      });
      if (!controller.signal.aborted) setUrl(result.url);
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Preview failed.'); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  };
  if (!plan.settings.mirror || !plan.settings.preserveEmbeddedText) return null;
  return <div className="embedded-caption-preview">
    <p className="field-hint">Render a five-second source picture sample to check embedded captions and area edges. The timeline shows the uncorrected flip. Saved speech captions, narration and supporting shots appear in the full export.</p>
    <button type="button" className="secondary-button" disabled={disabled} onClick={() => busy ? request.current?.abort() : void render()}>{busy ? 'Cancel caption preview' : 'Preview readable captions'}</button>
    {busy && <p role="status">Preparing caption sample…</p>}
    {error && <p role="alert">{error}</p>}
    {url && <video aria-label="Rendered embedded caption sample" src={url} controls playsInline style={{ width: '100%', maxHeight: 360, marginTop: 12 }} />}
  </div>;
}
