import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { EditPlan, EditPlanVisual } from '../shared/types';
import { clamp, cutTimeline, sourceAtTime, splitTimelineCut, shiftTimelineInterval } from '../shared/edit-timeline';
import { apiRequest } from './api-client';
import './edit-timeline.css';

type Item = { id: string; kind: 'cut' | 'caption' | 'visual' | 'hook'; start: number; end: number; label: string; locked?: boolean };
type Waveform = { peaks: number[]; duration: number; clock: 'source' | 'output' };
export default function EditTimeline({ jobId, plan, time, onSeek, onChange, onCuts, disabled, cutsDisabled }: {
  jobId: string; plan: EditPlan; time: number; onSeek: (time: number) => void; onChange: (plan: EditPlan) => void;
  onCuts: (cuts: EditPlan['cuts']) => Promise<void>; disabled: boolean; cutsDisabled: boolean;
}) {
  const [selected, setSelected] = useState<string>(), [zoom, setZoom] = useState(1), [error, setError] = useState('');
  const [wave, setWave] = useState<Waveform>(), [waveError, setWaveError] = useState(''), [drag, setDrag] = useState<Item>();
  const dragRef = useRef<{ item: Item; x: number; width: number; mode: 'move' | 'start' | 'end'; next: Item } | undefined>(undefined);
  const track = useRef<HTMLDivElement>(null);
  const duration = plan.outputDuration, cuts = cutTimeline(plan.cuts, plan.settings.speed);
  const items: Item[] = [...cuts.map(cut => ({ id: `cut:${cut.index}`, kind: 'cut' as const, start: cut.outputStart, end: cut.outputEnd, label: `Cut ${cut.index + 1}` })),
    ...plan.captions.map(cue => ({ ...cue, kind: 'caption' as const, label: cue.text })),
    ...plan.visuals.filter(shot => shot.enabled).map(shot => ({ ...shot, kind: 'visual' as const, label: plan.media.find(media => media.id === shot.mediaId)?.name || 'B-roll' })),
    ...(plan.settings.hookText ? [{ id: 'hook', kind: 'hook' as const, start: 0, end: Math.min(duration, plan.settings.hookDuration), label: plan.settings.hookText }] : [])];
  const active = items.find(item => item.id === selected);
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<Waveform>(`/api/jobs/${jobId}/waveform`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setWave(value); }).catch(e => { if (!controller.signal.aborted) setWaveError(e.message); });
    return () => controller.abort();
  }, [jobId]);
  const editable = (item: Item) => !disabled && !item.locked && !(item.kind === 'cut' && cutsDisabled);
  const change = (item: Item, delta: number, mode: 'move' | 'start' | 'end'): Item => {
    if (item.kind === 'cut') {
      const cut = cuts[Number(item.id.split(':')[1])]!, speed = plan.settings.speed;
      const timing = shiftTimelineInterval({ start: cut.start, end: cut.end }, delta * speed, mode, { low: 0, high: plan.sourceDuration, minimum: 0.04 });
      return { ...item, start: item.start + (timing.start - cut.start) / speed, end: item.end + (timing.end - cut.end) / speed };
    }
    if (item.kind === 'hook') return { ...item, end: clamp(item.end + delta, 0.5, Math.min(15, duration)) };
    const others = items.filter(other => other.kind === item.kind && other.id !== item.id);
    const low = Math.max(0, ...others.filter(other => other.end <= item.start).map(other => other.end));
    const high = Math.min(duration, ...others.filter(other => other.start >= item.end).map(other => other.start));
    const shot = plan.visuals.find(shot => shot.id === item.id), media = plan.media.find(media => media.id === shot?.mediaId);
    return { ...item, ...shiftTimelineInterval(item, delta, mode, { low, high, minimum: item.kind === 'visual' ? 0.5 : 0.04, maxLength: media && shot ? media.duration - shot.sourceStart : undefined }) };
  };
  const commit = async (original: Item, next: Item) => {
    setError('');
    try {
      if (original.kind === 'cut') {
        const index = Number(original.id.split(':')[1]);
        await onCuts(plan.cuts.map((cut, i) => i === index ? { ...cut, start: cut.start + (next.start - original.start) * plan.settings.speed, end: cut.end + (next.end - original.end) * plan.settings.speed } : cut));
      } else if (original.kind === 'hook') onChange({ ...plan, settings: { ...plan.settings, hookDuration: next.end } });
      else if (original.kind === 'caption') onChange({ ...plan, captions: plan.captions.map(cue => cue.id === original.id ? { ...cue, start: next.start, end: next.end } : cue) });
      else onChange({ ...plan, visuals: plan.visuals.map(shot => shot.id === original.id ? { ...shot, start: next.start, end: next.end } : shot) });
    } catch (e) { setError((e as Error).message); }
  };
  const begin = (event: ReactPointerEvent<HTMLElement>, item: Item, mode: 'move' | 'start' | 'end') => {
    event.stopPropagation(); setSelected(item.id);
    if (!editable(item) || (item.kind === 'cut' && mode === 'move')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { item, x: event.clientX, width: track.current!.getBoundingClientRect().width, mode, next: item };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current; if (!current) return;
    current.next = change(current.item, (event.clientX - current.x) / current.width * duration, current.mode); setDrag(current.next);
  };
  const finish = () => { const current = dragRef.current; dragRef.current = undefined; setDrag(undefined); if (current) void commit(current.item, current.next); };
  const at = (clientX: number) => clamp((clientX - track.current!.getBoundingClientRect().left) / track.current!.getBoundingClientRect().width * duration, 0, duration);
  const addShot = (mediaId: string, start: number) => {
    const media = plan.media.find(media => media.id === mediaId && media.kind !== 'audio'); if (!media) return;
    const occupied = plan.visuals.filter(shot => shot.enabled).sort((a,b) => a.start - b.start);
    if (occupied.some(shot => start >= shot.start && start < shot.end)) { setError('Drop the clip into an empty part of the B-roll track.'); return; }
    const end = Math.min(duration, start + 2, start + media.duration, occupied.find(shot => shot.start > start)?.start ?? duration);
    if (end - start < 0.5) { setError('Leave at least half a second for this shot.'); return; }
    if (occupied.length >= 10) { setError('This edit already has ten supporting shots. Remove one first.'); return; }
    const shot: EditPlanVisual = { id: crypto.randomUUID(), mediaId, start, end, sourceStart: 0, enabled: true, locked: false };
    onChange({ ...plan, visuals: [...plan.visuals, shot] }); setSelected(shot.id); setError('');
  };
  const remove = async () => {
    if (!active || !editable(active)) return;
    try {
      if (active.kind === 'cut') { if (plan.cuts.length === 1) throw new Error('Keep at least one cut.'); await onCuts(plan.cuts.filter((_, index) => index !== Number(active.id.split(':')[1]))); }
      else if (active.kind === 'caption') onChange({ ...plan, captions: plan.captions.filter(cue => cue.id !== active.id) });
      else if (active.kind === 'visual') onChange({ ...plan, visuals: plan.visuals.filter(shot => shot.id !== active.id) });
      else onChange({ ...plan, settings: { ...plan.settings, hookText: '' } });
      setSelected(undefined); setError('');
    } catch (e) { setError((e as Error).message); }
  };
  const peaks = Array.from({ length: 500 }, (_, index) => {
    if (!wave?.peaks.length) return 0;
    const t = (index + 0.5) / 500 * duration;
    const point = wave.clock === 'source' ? sourceAtTime(plan.cuts, plan.settings.speed, t).time : t % wave.duration;
    return wave.peaks[Math.min(wave.peaks.length - 1, Math.floor(point / wave.duration * wave.peaks.length))] ?? 0;
  });
  const maximum = Math.max(0.01, ...peaks);
  return <section className="edit-timeline" aria-label="Edit timeline">
    <header><div><h3>Timeline</h3><p>Drag clips or their edges. Click the ruler to seek. Arrow keys move the selected item.</p></div><label>Zoom <input aria-label="Timeline zoom" type="range" min={1} max={5} step={0.5} value={zoom} onChange={event => setZoom(event.target.valueAsNumber)} /></label></header>
    <div className="timeline-toolbar"><label>Playhead <input aria-label="Timeline playhead seconds" type="number" min={0} max={duration} step={0.01} value={Number(time.toFixed(2))} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onSeek(clamp(event.target.valueAsNumber,0,duration)); }} /> s</label>
      <button type="button" disabled={disabled || cutsDisabled} onClick={() => { try { void onCuts(splitTimelineCut(plan.cuts, plan.settings.speed, time)).catch(e => setError(e.message)); } catch(e) { setError((e as Error).message); } }}>Split at playhead</button>
      <button type="button" disabled={!active || !editable(active)} onClick={() => void remove()}>Remove selected</button>
      {active?.locked && <button type="button" disabled={disabled} onClick={() => onChange({ ...plan, visuals: plan.visuals.map(shot => shot.id === active.id ? { ...shot, locked: false } : shot) })}>Unlock shot</button>}
    </div>
    <div className="timeline-scroll"><div className="timeline-canvas" ref={track} style={{ width: `${zoom * 100}%` }}>
      <div className="timeline-ruler" role="slider" tabIndex={0} aria-label="Seek timeline" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time} onPointerDown={event => onSeek(at(event.clientX))} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onSeek(clamp(time + (event.key === 'ArrowLeft' ? -0.04 : 0.04),0,duration)); } }}>{Array.from({length: 11}, (_, i) => <span key={i} style={{ left: `${i * 10}%` }}>{(duration * i / 10).toFixed(1)}s</span>)}</div>
      {(['cut','hook','caption','visual'] as const).map(kind => <div key={kind} className={`timeline-lane lane-${kind}`} aria-label={`${kind} track`} onDragOver={event => { if (kind === 'visual' && !disabled) event.preventDefault(); }} onDrop={event => { if (kind !== 'visual' || disabled) return; event.preventDefault(); addShot(event.dataTransfer.getData('application/x-remix-media'), at(event.clientX)); }}>
        <span className="timeline-lane-label">{{cut: 'Cuts',hook: 'Hook',caption: 'Captions',visual: 'B-roll'}[kind]}</span>
        {items.filter(item => item.kind === kind).map(item => { const shown = drag?.id === item.id ? drag : item; return <div key={item.id} role="button" tabIndex={0} aria-label={`${item.label}, ${item.start.toFixed(2)} to ${item.end.toFixed(2)} seconds${item.locked ? ', locked' : ''}`} aria-pressed={selected === item.id} className={`timeline-item ${selected === item.id ? 'selected' : ''} ${item.locked ? 'locked' : ''}`} style={{ left: `${shown.start / duration * 100}%`, width: `${(shown.end - shown.start) / duration * 100}%` }}
          onClick={() => setSelected(item.id)} onPointerDown={event => begin(event,item,'move')} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { dragRef.current = undefined; setDrag(undefined); }}
          onKeyDown={event => { if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && editable(item)) { event.preventDefault(); event.stopPropagation(); const mode = item.kind === 'cut' || item.kind === 'hook' ? 'end' : 'move'; void commit(item,change(item,(event.key === 'ArrowLeft' ? -1 : 1)*(event.shiftKey ? 0.1 : 0.04),mode)); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(item.id); } }}>
          {item.kind !== 'hook' && <button type="button" className="timeline-handle start" aria-label={`Trim start of ${item.label}`} disabled={!editable(item)} onPointerDown={event => begin(event,item,'start')} onKeyDown={event => { if (event.key.startsWith('Arrow') && editable(item)) { event.preventDefault(); event.stopPropagation(); void commit(item, change(item,event.key === 'ArrowLeft' ? -0.04 : 0.04,'start')); } }} />}
          <span>{item.locked ? '🔒 ' : ''}{item.label}</span><button type="button" className="timeline-handle end" aria-label={`Trim end of ${item.label}`} disabled={!editable(item)} onPointerDown={event => begin(event,item,'end')} onKeyDown={event => { if (event.key.startsWith('Arrow') && editable(item)) { event.preventDefault(); event.stopPropagation(); void commit(item, change(item,event.key === 'ArrowLeft' ? -0.04 : 0.04,'end')); } }} />
        </div>; })}
      </div>)}
      <div className="timeline-audio"><span className="timeline-lane-label">Audio</span>{wave?.peaks.length ? <svg viewBox="0 0 500 48" preserveAspectRatio="none" role="img" aria-label="Audio waveform">{peaks.map((peak,index) => <line key={index} x1={index} x2={index} y1={24-peak/maximum*22} y2={24+peak/maximum*22} />)}</svg> : <p>{waveError || (wave ? 'No audio track' : 'Reading soundtrack…')}</p>}</div>
      <div className="timeline-playhead" style={{left: `${clamp(time,0,duration)/duration*100}%`}} />
    </div></div>
    {active && <div className="timeline-selection"><strong>{active.label}</strong>{(['start','end'] as const).map(edge => <label key={`${active.id}-${edge}-${active[edge]}`}>{edge === 'start' ? 'Start' : 'End'} (s)<input type="number" step={0.01} min={0} max={duration} disabled={!editable(active) || (active.kind === 'hook' && edge === 'start')} defaultValue={active[edge].toFixed(2)} onBlur={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && Math.abs(value-active[edge]) > 0.0001) void commit(active,change(active,value-active[edge],edge)); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label>)}</div>}
    {plan.media.some(media => media.kind !== 'audio') && <div className="timeline-media"><span>Saved footage · drag onto B-roll, or add at the playhead (up to 2s)</span>{plan.media.filter(media => media.kind !== 'audio').map(media => <button type="button" key={media.id} draggable={!disabled} disabled={disabled} onDragStart={event => event.dataTransfer.setData('application/x-remix-media',media.id)} onClick={() => addShot(media.id,time)}>{media.name} +</button>)}</div>}
    {cutsDisabled && <p className="timeline-note">Render your caption or B-roll changes before adjusting cut boundaries.</p>}
    {!!plan.settings.ownFootage?.length && <p className="timeline-note">This timeline follows the main edit. Uploaded inserts and covers are arranged in Your footage below.</p>}
    {error && <p role="alert" className="timeline-error">{error}</p>}
  </section>;
}
