import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ClipboardPaste, Copy, Keyboard, Magnet, MousePointer2, Redo2, Scissors, Trash2, Undo2, Upload } from 'lucide-react';
import type { EditPlan, EditPlanVisual, RenderJob } from '../shared/types';
import type { OwnFootageAsset } from '../shared/own-footage';
import { clamp, clipLength, mainTimeAt, outputTimeAt, pasteStory, sourceAtTime, splitStory, storyChanges, storyClips, storyTiming, shiftTimelineInterval, timecode, type StoryClip } from '../shared/edit-timeline';
import { withTrackBounds } from '../shared/focus';
import { apiRequest } from './api-client';
import './edit-timeline.css';

type Item = { id: string; kind: 'caption' | 'visual' | 'hook' | 'cover'; start: number; end: number; label: string; locked?: boolean };
type Waveform = { peaks: number[]; duration: number; clock: 'source' | 'output' };
type Gesture = { id: string; x: number; mode: 'move' | 'start' | 'end'; delta: number; boundary: number; moved: boolean };
const isTyping = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], video[controls]');
export default function EditTimeline({ jobId, job, plan, time, fps, onSeek, onChange, onCuts, disabled, onUndo, onRedo, canUndo, canRedo, onTransport, onImported, onBusy }: {
  jobId: string; job: RenderJob; plan: EditPlan; time: number; fps: number; onSeek: (time: number) => void; onChange: (plan: EditPlan) => void;
  onCuts: (cuts: EditPlan['cuts'], ownFootage?: EditPlan['settings']['ownFootage']) => Promise<void>; disabled: boolean;
  onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean; onTransport: (command: 'toggle' | 'pause' | 'forward' | 'reverse') => void;
  onImported: (assets: OwnFootageAsset[]) => void; onBusy: (busy: boolean) => void;
}) {
  const appleKeyboard = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/iu.test(navigator.platform);
  const modifier = appleKeyboard ? '⌘' : 'Ctrl+', shift = appleKeyboard ? '⇧' : 'Shift+';
  const shortcut = (key: string, shifted = false) => appleKeyboard ? `${shifted ? '⇧' : ''}⌘${key}` : `Ctrl+${shifted ? 'Shift+' : ''}${key}`;
  const redoShortcut = appleKeyboard ? shortcut('Z', true) : 'Ctrl+Y / Ctrl+Shift+Z';
  const [selected, setSelected] = useState<string[]>([]), [zoom, setZoom] = useState(1), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [tool, setTool] = useState<'select' | 'blade'>('select'), [snapping, setSnapping] = useState(true), [help, setHelp] = useState(false);
  const [clipboard, setClipboard] = useState<StoryClip[]>([]), [wave, setWave] = useState<Waveform>(), [waveError, setWaveError] = useState('');
  const [gesture, setGesture] = useState<Gesture>(), gestureRef = useRef<Gesture | undefined>(undefined);
  const section = useRef<HTMLElement>(null), track = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), pending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const clips = storyClips(plan, fps), timed = storyTiming(clips, plan.settings.speed), duration = timed.at(-1)?.outputEnd ?? plan.outputDuration;
  const mainDuration = timed.at(-1)?.mainEnd ?? plan.outputDuration;
  const items: Item[] = [
    ...plan.captions.map(cue => ({ ...cue, kind: 'caption' as const, label: cue.text })),
    ...plan.visuals.filter(shot => shot.enabled).map(shot => ({ ...shot, kind: 'visual' as const, label: plan.media.find(media => media.id === shot.mediaId)?.name || 'B-roll' })),
    ...(plan.settings.ownFootage ?? []).filter(item => item.mode === 'cover').map(item => ({ id: item.id, kind: 'cover' as const, start: item.at, end: Math.min(mainDuration, item.at + item.end - item.start), label: job.footageAssets?.find(asset => asset.id === item.assetId)?.name || 'Uploaded cover' })),
    ...(plan.settings.hookText ? [{ id: 'hook', kind: 'hook' as const, start: 0, end: Math.min(mainDuration, plan.settings.hookDuration), label: plan.settings.hookText }] : [])];
  const active = items.find(item => item.id === selected[0]), activeClip = clips.find(clip => clip.id === selected[0]);
  const label = (clip: StoryClip, index: number) => clip.kind === 'cut' ? `Clip ${index + 1}` : job.footageAssets?.find(asset => asset.id === clip.footage.assetId)?.name || 'Uploaded clip';
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<Waveform>(`/api/jobs/${jobId}/waveform`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setWave(value); }).catch(e => { if (!controller.signal.aborted) setWaveError(e.message); });
    return () => controller.abort();
  }, [jobId]);
  const run = async (action: () => void | Promise<void>) => {
    if (disabled || pending.current) return;
    pending.current = true; onBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { pending.current = false; onBusy(false); }
  };
  const applyStory = async (next: StoryClip[], nextTime = time) => {
    const changes = storyChanges(next, plan);
    await onCuts(changes.cuts, changes.ownFootage);
    setSelected([]); onSeek(clamp(nextTime, 0, storyTiming(next, plan.settings.speed).at(-1)!.outputEnd));
  };
  const split = (at = time) => run(async () => { await applyStory(splitStory(clips, plan.settings.speed, at, crypto.randomUUID()), at); setNotice('Clip split. Select either part to move or copy it.'); });
  const copy = () => {
    const copied = clips.filter(clip => selected.includes(clip.id));
    if (!copied.length) { setNotice('Select one or more clips on the Video track to copy.'); return; }
    setClipboard(structuredClone(copied)); setNotice(`${copied.length} clip${copied.length > 1 ? 's' : ''} copied. Place the playhead, then paste.`);
  };
  const paste = () => run(async () => {
    if (!clipboard.length) return;
    await applyStory(pasteStory(clips, clipboard, plan.settings.speed, time, () => crypto.randomUUID()), time + clipboard.reduce((sum, clip) => sum + clipLength(clip, plan.settings.speed), 0));
    setNotice('Pasted at the playhead. Following clips moved to make room.');
  });
  const importClips = (files: File[], atTime: number) => run(async () => {
    if (!files.length) return;
    if ((plan.settings.ownFootage?.length ?? 0) + files.length > 20) throw new Error('Keep at most 20 uploaded clips in this edit.');
    setNotice('Importing footage…');
    const data = new FormData(); files.forEach(file => data.append('videos',file));
    const result = await apiRequest<{ assets: OwnFootageAsset[]; errors?: { error: string }[] }>('/api/broll',{method:'POST',body:data});
    if (!result.assets.length) throw new Error(result.errors?.[0]?.error || 'The selected video could not be imported.');
    onImported(result.assets);
    const imported: StoryClip[] = result.assets.map(asset => { const id = crypto.randomUUID(); return {id,kind:'footage',footage:{id,assetId:asset.id,mode:'insert',at:0,start:0,end:asset.duration,audio:'clip',fit:'contain'}}; });
    await applyStory(pasteStory(clips,imported,plan.settings.speed,atTime,()=>crypto.randomUUID()),atTime);
    if (result.errors?.length) setError(result.errors.map(item=>item.error).join(' '));
    setNotice(`${result.assets.length} clip${result.assets.length > 1 ? 's' : ''} inserted. Drag the edges to trim.`);
  });
  const remove = () => run(async () => {
    if (activeClip) { const start = timed.find(clip => selected.includes(clip.id))?.outputStart ?? time; await applyStory(clips.filter(clip => !selected.includes(clip.id)), Math.min(time, start)); }
    else if (active && !active.locked) {
      if (active.kind === 'caption') onChange({ ...plan, captions: plan.captions.filter(cue => cue.id !== active.id) });
      else if (active.kind === 'visual') onChange({ ...plan, visuals: plan.visuals.filter(shot => shot.id !== active.id) });
      else if (active.kind === 'cover') onChange({ ...plan, settings: { ...plan.settings, ownFootage: plan.settings.ownFootage?.filter(item => item.id !== active.id) } });
      else onChange({ ...plan, settings: { ...plan.settings, hookText: '' } });
      setSelected([]);
    }
  });
  const select = (id: string, extend: boolean, toggle: boolean) => {
    if (extend && clips.some(clip => clip.id === id) && clips.some(clip => clip.id === selected[0])) {
      const a = clips.findIndex(clip => clip.id === selected[0]), b = clips.findIndex(clip => clip.id === id);
      setSelected(clips.slice(Math.min(a,b), Math.max(a,b)+1).map(clip => clip.id));
    } else if (toggle && clips.some(clip => clip.id === id)) setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current.filter(value => clips.some(clip => clip.id === value)), id]);
    else setSelected([id]);
  };
  const at = (x: number) => clamp((x - track.current!.getBoundingClientRect().left) / track.current!.getBoundingClientRect().width * duration, 0, duration);
  const quantize = (value: number) => Math.round(value * fps) / fps;
  const snap = (value: number, candidates: number[]) => {
    if (!snapping) return quantize(value);
    const closest = candidates.reduce((best, next) => Math.abs(value-next) < Math.abs(value-best) ? next : best, Infinity);
    return Math.abs(value-closest) <= duration / (track.current?.getBoundingClientRect().width || 800) * 9 ? closest : quantize(value);
  };
  const begin = (event: ReactPointerEvent<HTMLElement>, id: string, mode: Gesture['mode']) => {
    event.stopPropagation();
    if (disabled || pending.current || event.button !== 0) return;
    if (tool === 'blade' && mode === 'move' && clips.some(clip => clip.id === id)) { void split(quantize(at(event.clientX))); return; }
    if (!selected.includes(id) || event.shiftKey || event.metaKey || event.ctrlKey) select(id, event.shiftKey, event.metaKey || event.ctrlKey);
    section.current?.focus({ preventScroll: true });
    if (items.find(item => item.id === id)?.locked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { id, x: event.clientX, mode, delta: 0, boundary: 0, moved: false };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gestureRef.current; if (!current) return;
    const viewport = scroll.current!.getBoundingClientRect();
    if (event.clientX > viewport.right - 32) scroll.current!.scrollLeft += 16;
    else if (event.clientX < viewport.left + 32) scroll.current!.scrollLeft -= 16;
    current.moved ||= Math.abs(event.clientX - current.x) > 4;
    current.delta = (event.clientX - current.x) / track.current!.getBoundingClientRect().width * duration;
    const boundaries = [0, ...timed.map(clip => clip.outputEnd)];
    current.boundary = boundaries.reduce((best, point, index) => Math.abs(point - at(event.clientX)) < Math.abs(boundaries[best]! - at(event.clientX)) ? index : best, 0);
    setGesture({ ...current });
  };
  const overlayChange = (item: Item, delta: number, mode: Gesture['mode']) => {
    if (item.kind === 'hook') return { start: 0, end: clamp(item.end + delta, .5, Math.min(15, mainDuration)) };
    const others = items.filter(other => other.kind === item.kind && other.id !== item.id);
    const shot = plan.visuals.find(shot => shot.id === item.id), media = plan.media.find(media => media.id === shot?.mediaId);
    return shiftTimelineInterval(item, delta, mode, { low: Math.max(0, ...others.filter(other => other.end <= item.start).map(other => other.end)), high: Math.min(mainDuration, ...others.filter(other => other.start >= item.end).map(other => other.start)), minimum: item.kind === 'visual' ? .5 : .04, maxLength: media && shot ? media.duration - shot.sourceStart : undefined });
  };
  const trimClip = async (clip: StoryClip, delta: number, mode: 'start' | 'end') => {
    const interval = clip.kind === 'cut' ? clip.cut : clip.footage, speed = clip.kind === 'cut' ? plan.settings.speed : 1;
    const high = clip.kind === 'cut' ? plan.sourceDuration : job.footageAssets?.find(asset => asset.id === clip.footage.assetId)?.duration ?? interval.end;
    const timing = shiftTimelineInterval(interval, delta * speed, mode, { low: 0, high, minimum: clip.kind === 'cut' ? .04 : .1 });
    const next: StoryClip = clip.kind === 'cut' ? { ...clip, cut: withTrackBounds({ ...clip.cut, ...timing }) } : { ...clip, footage: { ...clip.footage, ...timing, appendToEnd: false } };
    await applyStory(clips.map(item => item.id === clip.id ? next : item));
  };
  const commitOverlay = (item: Item, delta: number, mode: Gesture['mode']) => {
    const timing = overlayChange(item, delta, mode);
    if (item.kind === 'hook') onChange({ ...plan, settings: { ...plan.settings, hookDuration: timing.end } });
    else if (item.kind === 'caption') onChange({ ...plan, captions: plan.captions.map(cue => cue.id === item.id ? { ...cue, ...timing } : cue) });
    else if (item.kind === 'cover') onChange({ ...plan, settings: { ...plan.settings, ownFootage: plan.settings.ownFootage?.map(shot => shot.id === item.id ? { ...shot, at: timing.start, end: shot.start + timing.end - timing.start } : shot) } });
    else onChange({ ...plan, visuals: plan.visuals.map(shot => shot.id === item.id ? { ...shot, ...timing } : shot) });
  };
  const finish = () => {
    const current = gestureRef.current; gestureRef.current = undefined; setGesture(undefined);
    if (!current?.moved) return;
    void run(async () => {
      const clip = clips.find(clip => clip.id === current.id);
      if (clip && current.mode === 'move') {
        const moving = clips.filter(clip => selected.includes(clip.id) || clip.id === current.id);
        const before = clips.slice(0, current.boundary).filter(clip => !moving.includes(clip));
        const after = clips.slice(current.boundary).filter(clip => !moving.includes(clip));
        await applyStory([...before, ...moving, ...after], before.reduce((sum, clip) => sum + clipLength(clip, plan.settings.speed), 0));
      } else if (clip) {
        const shown = timed.find(item => item.id === clip.id)!;
        const edge = current.mode === 'start' ? shown.outputStart : shown.outputEnd;
        const delta = snap(edge + current.delta, [time, ...timed.flatMap(item => [item.outputStart,item.outputEnd])]) - edge;
        await trimClip(clip, delta, current.mode as 'start' | 'end');
      } else {
        const item = items.find(item => item.id === current.id)!;
        const origin = outputTimeAt(clips, plan.settings.speed, item.start);
        const delta = mainTimeAt(clips, plan.settings.speed, snap(origin + current.delta, [time, ...timed.map(item => item.outputStart)])) - item.start;
        commitOverlay(item, delta, current.mode);
      }
    });
  };
  const addShot = (mediaId: string, outputTime: number) => {
    const start = mainTimeAt(clips, plan.settings.speed, outputTime), media = plan.media.find(media => media.id === mediaId && media.kind !== 'audio'); if (!media) return;
    const occupied = plan.visuals.filter(shot => shot.enabled).sort((a,b) => a.start - b.start);
    if (occupied.some(shot => start >= shot.start && start < shot.end)) { setError('Drop into an empty part of the B-roll track.'); return; }
    const end = Math.min(mainDuration, start + 2, start + media.duration, occupied.find(shot => shot.start > start)?.start ?? mainDuration);
    if (end - start < .5) { setError('Leave at least half a second for this shot.'); return; }
    if (occupied.length >= 10) { setError('Remove a supporting shot before adding another (maximum 10).'); return; }
    const shot: EditPlanVisual = { id: crypto.randomUUID(), mediaId, start, end, sourceStart: 0, enabled: true, locked: false };
    onChange({ ...plan, visuals: [...plan.visuals, shot] }); setSelected([shot.id]); setError('');
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !section.current?.closest('[role="dialog"]')?.contains(document.activeElement) || isTyping(event.target) || event.altKey) return;
      const key = event.key.toLowerCase(), command = event.metaKey || event.ctrlKey;
      if (command && key === 'b') { event.preventDefault(); void split(); }
      else if (command && key === 'c') { if (activeClip) { event.preventDefault(); copy(); } }
      else if (command && key === 'x') { if (activeClip && !disabled) { event.preventDefault(); copy(); void remove(); } }
      else if (command && key === 'v') { if (clipboard.length) { event.preventDefault(); void paste(); } }
      else if (command && key === 'z') { event.preventDefault(); if (!disabled) { if (event.shiftKey) onRedo(); else onUndo(); } }
      else if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'y') { event.preventDefault(); if (!disabled) onRedo(); }
      else if (command && key === 'a') { event.preventDefault(); setSelected(clips.map(clip => clip.id)); }
      else if (command && (key === '=' || key === '+' || key === '-')) { event.preventDefault(); setZoom(value => clamp(value + (key === '-' ? -.5 : .5), 1, 8)); }
      else if (!command && key === 'z' && event.shiftKey) { event.preventDefault(); setZoom(1); }
      else if (!command && ['a','b','n'].includes(key)) { event.preventDefault(); if (key === 'n') setSnapping(value => !value); else setTool(key === 'a' ? 'select' : 'blade'); }
      else if (!command && [' ','j','k','l'].includes(key)) { event.preventDefault(); onTransport(key === ' ' ? 'toggle' : key === 'j' ? 'reverse' : key === 'k' ? 'pause' : 'forward'); }
      else if (!command && ['arrowleft','arrowright','arrowup','arrowdown','home','end'].includes(key)) {
        event.preventDefault(); onTransport('pause');
        const boundaries = [0, ...timed.map(clip => clip.outputEnd)];
        const next = key === 'home' ? 0 : key === 'end' ? duration : key === 'arrowup' ? boundaries.filter(value => value < time - .001).at(-1) ?? 0 : key === 'arrowdown' ? boundaries.find(value => value > time + .001) ?? duration : time + (key === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 10 : 1) / fps;
        onSeek(clamp(next,0,duration));
      } else if (!command && ['backspace','delete'].includes(key) && selected.length) { event.preventDefault(); void remove(); }
      else if (key === '?') { event.preventDefault(); setHelp(value => !value); }
    };
    window.addEventListener('keydown',keydown); return () => window.removeEventListener('keydown',keydown);
  });
  const peaks = Array.from({ length: 400 }, (_, index) => {
    if (!wave?.peaks.length) return 0;
    const outputTime = (index + .5) / 400 * duration, clip = timed.find(clip => outputTime < clip.outputEnd);
    if (clip?.kind !== 'cut') return 0;
    const main = mainTimeAt(clips, plan.settings.speed, outputTime), point = wave.clock === 'source' ? sourceAtTime(plan.cuts,plan.settings.speed,main).time : main;
    return wave.peaks[Math.min(wave.peaks.length - 1, Math.floor(point / wave.duration * wave.peaks.length))] ?? 0;
  });
  const maximum = Math.max(.01,...peaks), dropAt = gesture && timed.some(clip => clip.id === gesture.id) && gesture.mode === 'move' && gesture.moved ? (gesture.boundary ? timed[gesture.boundary-1]!.outputEnd : 0) : undefined;
  const handlers = { onPointerMove: move, onPointerUp: finish, onPointerCancel: () => { gestureRef.current = undefined; setGesture(undefined); } };
  const handle = (id: string, title: string, edge: 'start' | 'end', locked = false) => <button type="button" className={`timeline-handle ${edge}`} aria-label={`Trim ${edge} of ${title}`} disabled={disabled || locked} onPointerDown={event => begin(event,id,edge)} {...handlers} />;
  return <section ref={section} className="edit-timeline" aria-label="Edit timeline" tabIndex={0}>
    <header><div><h3>Timeline <span>{clips.length} clip{clips.length === 1 ? '' : 's'} · {duration.toFixed(2)} s</span></h3><p>Select a clip. Drag to reorder; drag its edges to trim. Shift-click to select a sequence.</p></div><button type="button" onClick={() => setHelp(!help)} aria-expanded={help}><Keyboard size={15} /> Shortcuts <kbd>?</kbd></button></header>
    <div className="timeline-toolbar" aria-label="Editing tools">
      <div className="timeline-tool-group"><button type="button" aria-label="Select tool" aria-pressed={tool === 'select'} title="Select tool (A)" onClick={() => setTool('select')}><MousePointer2 size={15} /><span>Select</span><kbd>A</kbd></button><button type="button" aria-label="Blade tool" aria-pressed={tool === 'blade'} title="Blade tool (B): click a clip to split" onClick={() => setTool('blade')}><Scissors size={15} /><span>Blade</span><kbd>B</kbd></button></div>
      <button type="button" disabled={disabled} onClick={() => void split()} title={`Split at playhead (${shortcut('B')})`}><Scissors size={15} /> Split <kbd>{shortcut('B')}</kbd></button>
      <button type="button" disabled={!activeClip || disabled} onClick={copy} title={`Copy selected clips (${shortcut('C')})`}><Copy size={15} /><span>Copy</span></button>
      <button type="button" disabled={!clipboard.length || disabled} onClick={() => void paste()} title={`Insert copied clips at playhead (${shortcut('V')})`}><ClipboardPaste size={15} /><span>Paste</span></button>
      <button type="button" disabled={!selected.length || disabled || !!active?.locked} onClick={() => void remove()} title="Delete selected and close gap (Delete)"><Trash2 size={15} /><span>Delete</span></button>
      <div className="timeline-tool-group"><button type="button" aria-label="Undo edit" title={`Undo (${shortcut('Z')})`} disabled={!canUndo || disabled} onClick={onUndo}><Undo2 size={15} /></button><button type="button" aria-label="Redo edit" title={`Redo (${redoShortcut})`} disabled={!canRedo || disabled} onClick={onRedo}><Redo2 size={15} /></button></div>
      <button type="button" aria-label="Snapping" aria-pressed={snapping} title="Snap to playhead and clip edges (N)" onClick={() => setSnapping(!snapping)}><Magnet size={15} /></button>
      <button type="button" disabled={disabled} onClick={() => fileInput.current?.click()} title="Insert video files at the playhead"><Upload size={15} /><span>Import clip</span></button>
      <input ref={fileInput} aria-label="Import video clips" type="file" accept="video/*,.mkv,.mov,.mp4,.webm" multiple hidden onChange={event => { const files=Array.from(event.target.files || []); event.target.value=''; void importClips(files,time); }} />
      <label className="timeline-zoom">Zoom <input aria-label="Timeline zoom" type="range" min={1} max={8} step={.5} value={zoom} onChange={event => setZoom(event.target.valueAsNumber)} /><button type="button" onClick={() => setZoom(1)} title={`Fit timeline (${shift}Z)`}>Fit</button></label>
    </div>
    {help && <div className="timeline-shortcuts"><strong>Timeline shortcuts <small>{appleKeyboard ? 'Mac: ⌘ Command' : 'Windows / Linux: Ctrl'}. Text fields keep their usual shortcuts.</small></strong>{[
      ['A / B','Select / Blade tool'],[shortcut('B'),'Split at playhead'],[`${shortcut('C')} / ${shortcut('X')} / ${shortcut('V')}`,'Copy / cut / insert clips'],
      ['Delete / Backspace','Delete and close gap'],[shortcut('Z'),'Undo'],[redoShortcut,'Redo'],[shortcut('A'),'Select all clips'],
      ['Space · J K L','Play/pause · reverse, pause, forward'],[`← → · ${shift}← ${shift}→`,'Move 1 frame · 10 frames'],['↑ ↓ · Home / End','Cut boundaries · start / end'],
      [`N · ${shift}Z`,'Snapping · fit timeline'],[`${shortcut('+')} / ${shortcut('-')}`,'Zoom in / out'],
      [`${shift}click · ${modifier}${appleKeyboard ? ' ' : ''}click`,'Select range · add/remove clip'],[shortcut('Enter'),'Add/remove focused clip'],
    ].map(([key,value]) => <div key={key}><kbd>{key}</kbd><span>{value}</span></div>)}</div>}
    <div className="timeline-position"><output>{timecode(clamp(time,0,duration),fps)}</output><label>Playhead <input aria-label="Timeline playhead seconds" type="number" min={0} max={duration} step="any" value={Math.min(duration,Number(time.toFixed(3)))} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onSeek(clamp(event.target.valueAsNumber,0,duration)); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); section.current?.focus(); } }} /> s</label><span>{tool === 'blade' ? 'Blade: click inside a video clip to split it.' : selected.length ? `${selected.length} selected` : 'Click a clip to select it'}</span>{disabled && <span role="status">Updating…</span>}</div>
    <div className="timeline-scroll" ref={scroll}><div className={`timeline-canvas ${tool === 'blade' ? 'blade-tool' : ''}`} ref={track} style={{ width: `${zoom * 100}%` }}>
      <div className="timeline-ruler" role="slider" tabIndex={0} aria-label="Seek timeline" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={clamp(time,0,duration)} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); onSeek(quantize(at(event.clientX))); }} onPointerMove={event => { if (event.buttons === 1) onSeek(quantize(at(event.clientX))); }}>{Array.from({length: 11}, (_, i) => <span key={i} style={{ left: `${i * 10}%` }}>{(duration * i / 10).toFixed(1)}s</span>)}</div>
      <div className="timeline-lane lane-cut" aria-label="Video track" onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect='copy'; } }} onDrop={event => { if (disabled || !event.dataTransfer.files.length) return; event.preventDefault(); void importClips(Array.from(event.dataTransfer.files),snap(at(event.clientX),[0,...timed.map(clip=>clip.outputEnd)])); }}><span className="timeline-lane-label">Video · reorder clips or drop video files here</span>{timed.map((clip,index) => {
        const title = label(clip,index), selectedClip = selected.includes(clip.id), moving = gesture?.id === clip.id && gesture.moved;
        let start = clip.outputStart, end = clip.outputEnd;
        if (moving && gesture.mode === 'start') start = clamp(start + gesture.delta, 0, end - .04);
        if (moving && gesture.mode === 'end') end = Math.max(start + .04, end + gesture.delta);
        return <div key={clip.id} role="button" tabIndex={0} aria-label={`${title}, ${clip.outputStart.toFixed(2)} to ${clip.outputEnd.toFixed(2)} seconds`} aria-pressed={selectedClip} className={`timeline-item ${selectedClip ? 'selected' : ''} ${clip.kind === 'footage' ? 'uploaded-clip' : ''} ${moving ? 'is-dragging' : ''}`} style={{ left: `${start/duration*100}%`, width: `${(end-start)/duration*100}%` }} onPointerDown={event => begin(event,clip.id,'move')} {...handlers}  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); select(clip.id,event.shiftKey,event.metaKey || event.ctrlKey); } }}>
          {handle(clip.id,title,'start')}<img src={clip.kind === 'cut' ? `/api/sources/${plan.sourceId}/thumbnail` : job.footageAssets?.find(asset => asset.id === clip.footage.assetId)?.thumbnailUrl} alt="" hidden={clip.kind === 'footage'} draggable={false} /><span>{title}<small>{(clip.outputEnd-clip.outputStart).toFixed(2)} s</small></span>{handle(clip.id,title,'end')}
        </div>;
      })}</div>
      {(['hook','caption','visual'] as const).map(kind => <div key={kind} className={`timeline-lane lane-${kind}`} aria-label={`${kind} track`} onDragOver={event => { if (kind === 'visual' && !disabled) event.preventDefault(); }} onDrop={event => { if (kind !== 'visual' || disabled) return; event.preventDefault(); addShot(event.dataTransfer.getData('application/x-remix-media'), at(event.clientX)); }}>
        <span className="timeline-lane-label">{{hook:'Title',caption:'Captions',visual:'B-roll / cover'}[kind]}</span>
        {items.filter(item => item.kind === kind || (kind === 'visual' && item.kind === 'cover')).flatMap(item => {
          const shown = gesture?.id === item.id ? { ...item, ...overlayChange(item,gesture.delta,gesture.mode) } : item;
          // Inserts interrupt overlays; show only the portions over main footage.
          return timed.filter(clip => clip.kind === 'cut' && clip.mainEnd > shown.start && clip.mainStart < shown.end).map(clip => {
            const start = clip.outputStart + Math.max(0,shown.start-clip.mainStart), end = clip.outputEnd - Math.max(0,clip.mainEnd-shown.end);
            return <div key={`${item.id}:${clip.id}`} role="button" tabIndex={0} aria-label={item.label} aria-pressed={selected.includes(item.id)} className={`timeline-item ${selected.includes(item.id) ? 'selected' : ''} ${item.locked ? 'locked' : ''}`} style={{ left:`${start/duration*100}%`,width:`${(end-start)/duration*100}%` }} onPointerDown={event => begin(event,item.id,'move')} {...handlers} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setSelected([item.id]); } }}>
              {item.kind !== 'hook' && handle(item.id,item.label,'start',item.locked)}<span>{item.locked ? '🔒 ' : ''}{item.label}</span>{handle(item.id,item.label,'end',item.locked)}
            </div>;
          });
        })}
      </div>)}
      {(wave?.peaks.length || waveError || !wave) ? <div className="timeline-audio"><span className="timeline-lane-label">Main audio</span>{wave?.peaks.length ? <svg viewBox="0 0 400 42" preserveAspectRatio="none" role="img" aria-label="Audio waveform">{peaks.map((peak,index) => <line key={index} x1={index} x2={index} y1={21-peak/maximum*18} y2={21+peak/maximum*18} />)}</svg> : <p>{waveError || 'Reading soundtrack…'}</p>}</div> : null}
      <div className="timeline-playhead" style={{left:`${clamp(time,0,duration)/duration*100}%`}} />
      {dropAt !== undefined && <div className="timeline-drop-marker" style={{left:`${dropAt/duration*100}%`}}><span>Insert here</span></div>}
    </div></div>
    <div className="timeline-context">
      {activeClip && selected.length === 1 && <><strong>{label(activeClip,clips.indexOf(activeClip))}</strong><span>Source trim</span>{(['start','end'] as const).map(edge => { const interval = activeClip.kind === 'cut' ? activeClip.cut : activeClip.footage; return <label key={`${activeClip.id}-${edge}-${interval[edge]}`}>{edge}<input aria-label={`Selected clip source ${edge}`} type="number" step="any" min={0} defaultValue={interval[edge].toFixed(3)} disabled={disabled} onBlur={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && Math.abs(value-Number(interval[edge].toFixed(3))) > .0001) void run(() => trimClip(activeClip,(value-interval[edge])/(activeClip.kind === 'cut' ? plan.settings.speed : 1),edge)); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label>; })}</>}
      {active && <><strong>{active.label}</strong>{active.locked ? <button type="button" disabled={disabled} onClick={() => onChange({...plan,visuals:plan.visuals.map(shot => shot.id === active.id ? {...shot,locked:false} : shot)})}>Unlock shot to edit</button> : <span>Drag to move · use the edges to trim</span>}</>}
      {!selected.length && <span>Split → select → copy → place the playhead → paste. Changes appear in the live preview.</span>}
    </div>
    {plan.media.some(media => media.kind !== 'audio') && <details className="timeline-media"><summary>Saved B-roll · drag a shot to the B-roll track</summary>{plan.media.filter(media => media.kind !== 'audio').map(media => <button type="button" key={media.id} draggable={!disabled} disabled={disabled} onDragStart={event => event.dataTransfer.setData('application/x-remix-media',media.id)} onClick={() => addShot(media.id,time)}>{media.name} + 2 s</button>)}</details>}
    {notice && <p role="status" className="timeline-notice">{notice}</p>}{error && <p role="alert" className="timeline-error">{error}</p>}
  </section>;
}
