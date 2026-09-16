import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronRight, Clapperboard, Copy, Link2, LoaderCircle, Play, Plus, Scissors, Trash2, X } from "lucide-react";
import { DEFAULT_SETTINGS, type FocalPoint, type FocusKeyframe, type RenderJob, type RemixSettings, type VideoSource } from "../shared/types";
import { createShortDraft, formatSourceClock, matchingShortSource, MAX_SHORT_CUTS, MAX_SHORTS, parseSourceClock, reconnectShortDraft, restoreShortDrafts, shortCropGuide, shortFocusSignature, SHORT_DRAFT_STORAGE, validateShortDraft, type ShortCut, type ShortDraft, type ShortFocusAnalysis } from "../shared/shorts";
import { focusPointAt, validFocusTrack } from "../shared/focus";
import Slider from "./Slider";
import CropDragOverlay from "./CropDragOverlay";
import ClipDiscovery from "./ClipDiscovery";
import FinishingPresets from "./FinishingPresets";
import "./shorts.css";

type Props = {
  active: boolean;
  sources: VideoSource[];
  selectedSource?: VideoSource;
  engineReady: boolean;
  onSelectSource: (id: string) => void;
  onQueued: (jobs: RenderJob[]) => void;
  onNotice: (message: string, kind: "info" | "success" | "error") => void;
};
const initialDrafts = () => {
  try { return restoreShortDrafts(JSON.parse(localStorage.getItem(SHORT_DRAFT_STORAGE) || "null")); }
  catch { return []; }
};
interface FocusResult {
  status: ShortFocusAnalysis["status"];
  tracks: { cutIndex: number; start: number; end: number; keyframes: FocusKeyframe[]; coverage: number }[];
  multipleFaces: boolean;
  reason?: string;
}
const durationLabel = (seconds: number) => seconds >= 60 ? `${Math.floor(Math.round(seconds) / 60)}m ${Math.round(seconds) % 60}s` : `${Number(seconds.toFixed(2))}s`;
async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data as T;
}

export default function LongFormPanel({ active, sources, selectedSource: source, engineReady, onSelectSource, onQueued, onNotice }: Props) {
  const [drafts, setDrafts] = useState<ShortDraft[]>(initialDrafts);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cutId, setCutId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [scope, setScope] = useState<"current" | "selected" | "all">("current");
  const [clock, setClock] = useState("00:00:00.000");
  const [playhead, setPlayhead] = useState(0);
  const [clockEditing, setClockEditing] = useState(false);
  const [codecError, setCodecError] = useState(false);
  const [savingError, setSavingError] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; duration: number; label: string; kind: "short" | "source"; sourceStart: number; sourceId: string } | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [focusBusyId, setFocusBusyId] = useState<string | null>(null);
  const [focusRetry, setFocusRetry] = useState(0);
  const [frozenFocus, setFrozenFocus] = useState<{ context: string; point: FocalPoint } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const sampleVideo = useRef<HTMLVideoElement>(null);
  const clockOwner = useRef<"source" | "sample" | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const draft = drafts.find(item => item.id === activeId);
  const draftSource = draft ? sources.find(item => item.id === draft.sourceId) : undefined;
  const currentCut = draft?.cuts.find(cut => cut.id === cutId) || draft?.cuts[0];
  const validation = draft ? validateShortDraft(draft, draftSource) : null;
  const clockSeconds = parseSourceClock(clock);
  const clockValid = !!source && clockSeconds !== null && clockSeconds <= source.duration + 0.001;
  const startClockValid = clockValid && source!.duration - clockSeconds! > 0.04;
  const targets = scope === "current" ? (draft ? [draft] : []) : scope === "selected" ? drafts.filter(item => selectedIds.includes(item.id)) : drafts;
  const previewSignature = JSON.stringify({ draft, sourceId: source?.id });
  const focusSignature = draft ? shortFocusSignature(draft) : "";
  const focusReady = !!draft && draft.focusAnalysis?.signature === focusSignature;
  const focusContext = `${draft?.id}:${currentCut?.id}:${currentCut?.start}:${currentCut?.end}`;

  useEffect(() => {
    try { localStorage.setItem(SHORT_DRAFT_STORAGE, JSON.stringify({ version: 1, drafts })); setSavingError(false); }
    catch { setSavingError(true); }
  }, [drafts]);
  useEffect(() => {
    clockOwner.current = null; setPlayhead(0); setClock("00:00:00.000"); setCodecError(false); setClockEditing(false);
    setActiveId(current => {
      const currentDraft = drafts.find(item => item.id === current);
      return currentDraft?.sourceId === source?.id || (currentDraft && !sources.some(item => item.id === currentDraft.sourceId)) ? current : drafts.find(item => item.sourceId === source?.id)?.id || null;
    });
    // Source selection should not reset the playhead on every timestamp edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);
  useEffect(() => { setCutId(draft?.cuts[0]?.id || null); }, [draft?.id]);
  useEffect(() => {
    previewRequest.current?.abort(); previewRequest.current = null;
    setPreviewBusy(false); setPreview(current => current?.kind === "source" && current.sourceId === source?.id ? current : null); setPreviewError("");
  }, [previewSignature]);
  useEffect(() => {
    if (!active) { video.current?.pause(); sampleVideo.current?.pause(); previewRequest.current?.abort(); }
    return () => { video.current?.pause(); sampleVideo.current?.pause(); previewRequest.current?.abort(); };
  }, [active]);
  useEffect(() => { setFrozenFocus(null); }, [focusContext, active]);
  useEffect(() => {
    if (!active || !draft?.autoFocus || draft.fit !== "crop" || !draftSource || !engineReady || draft.focusAnalysis?.signature === focusSignature) return;
    const checked = validateShortDraft({ ...draft, autoFocus: false }, draftSource);
    if (!checked.settings) return;
    const id = draft.id, cuts = checked.settings.segments!;
    const controller = new AbortController();
    setFocusBusyId(id);
    const save = (result: FocusResult) => {
      if (controller.signal.aborted) return;
      setDrafts(current => current.map(item => {
        if (item.id !== id || !item.autoFocus || item.fit !== "crop" || shortFocusSignature(item) !== focusSignature) return item;
        return { ...item, cuts: item.cuts.map((cut, index) => {
          const { focusTrack: _oldTrack, ...manualCut } = cut;
          const track = result.tracks.find(value => value.cutIndex === index);
          return { ...manualCut, ...(track && validFocusTrack(track.keyframes, cuts[index].start, cuts[index].end) ? { focusTrack: track.keyframes } : {}) };
        }), focusAnalysis: { signature: focusSignature, status: result.status, multipleFaces: result.multipleFaces, reason: result.reason }, updatedAt: new Date().toISOString() };
      }));
    };
    const timer = window.setTimeout(() => {
      void post<FocusResult>("/api/speaker-focus", { sourceId: draft.sourceId, cuts, seed: draft.focalPoint, mode: draft.focusMode || "face" }, controller.signal)
        .then(save)
        .catch(error => { if (!controller.signal.aborted) save({ status: "unavailable", tracks: [], multipleFaces: false, reason: error instanceof Error ? error.message : "Automatic centering could not complete." }); })
        .finally(() => { if (!controller.signal.aborted) setFocusBusyId(current => current === id ? null : current); });
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); setFocusBusyId(current => current === id ? null : current); };
    // The signature covers the source, manual starting point and exact cuts.
    // Saving analysis must not restart or abort its own request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, draft?.id, draft?.autoFocus, draft?.fit, draftSource?.id, engineReady, focusSignature, focusRetry]);

  const updateDraft = (patch: Partial<ShortDraft>) => {
    if (!draft) return;
    setDrafts(current => current.map(item => item.id === draft.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item));
    setError("");
  };
  const selectDraft = (item: ShortDraft) => {
    clockOwner.current = null; video.current?.pause(); sampleVideo.current?.pause(); setError("");
    setActiveId(item.id);
    if (sources.some(source => source.id === item.sourceId)) onSelectSource(item.sourceId);
  };
  const addDraft = () => {
    if (!source || drafts.length >= MAX_SHORTS) return;
    const added = createShortDraft(source, crypto.randomUUID(), crypto.randomUUID(), clockValid ? clockSeconds! : 0, drafts.length + 1);
    setDrafts(current => [...current, added]); setActiveId(added.id); setCutId(added.cuts[0].id);
  };
  const duplicate = () => {
    if (!draft || drafts.length >= MAX_SHORTS) return;
    const added = { ...draft, id: crypto.randomUUID(), title: `${draft.title.slice(0, 93)} (copy)`, cuts: draft.cuts.map(cut => ({ ...cut, id: crypto.randomUUID() })), updatedAt: new Date().toISOString() };
    setDrafts(current => [...current, added]); setActiveId(added.id);
  };
  const updateCut = (id: string, patch: Partial<ShortCut>) => {
    if (draft) updateDraft({ cuts: draft.cuts.map(cut => cut.id === id ? { ...cut, ...patch } : cut) });
  };
  const moveCut = (index: number, direction: number) => {
    if (!draft) return;
    const next = [...draft.cuts];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    updateDraft({ cuts: next });
  };
  const seek = (seconds: number) => {
    if (!source) return;
    const next = Math.min(Math.max(0, seconds), source.duration);
    clockOwner.current = codecError ? null : "source"; video.current?.pause(); sampleVideo.current?.pause();
    if (video.current && !codecError) { try { video.current.currentTime = next; } catch { /* The clock also works before metadata is available. */ } }
    setPlayhead(next); setClock(formatSourceClock(next));
  };
  const mark = (edge: "start" | "end") => {
    if (!currentCut || !source || draftSource?.id !== source.id) return;
    const playingTime = preview?.kind === "source" && sampleVideo.current && !sampleVideo.current.paused
      ? preview.sourceStart + sampleVideo.current.currentTime
      : video.current && !video.current.paused ? video.current.currentTime : clockSeconds;
    if (playingTime === null || playingTime < 0 || playingTime > source.duration + 0.001 || (edge === "start" && source.duration - playingTime <= 0.04)) return;
    clockOwner.current = null; video.current?.pause(); sampleVideo.current?.pause();
    setPlayhead(playingTime); setClock(formatSourceClock(playingTime));
    updateCut(currentCut.id, { [edge]: formatSourceClock(playingTime) });
  };
  const addCut = () => {
    if (!draft || !draftSource || draft.cuts.length >= MAX_SHORT_CUTS) return;
    const start = clockValid && source?.id === draft.sourceId ? Math.min(clockSeconds!, Math.max(0, draftSource.duration - 0.05)) : 0;
    const cut = { id: crypto.randomUUID(), start: formatSourceClock(start), end: formatSourceClock(Math.min(draftSource.duration, start + 15)) };
    updateDraft({ cuts: [...draft.cuts, cut] }); setCutId(cut.id);
  };
  const renderPreview = async (kind: "short" | "source") => {
    const chosenSource = kind === "short" ? draftSource : source;
    if (!chosenSource || previewRequest.current) return;
    let settings: RemixSettings;
    if (kind === "short") {
      if (!validation?.settings) return;
      settings = validation.settings;
    } else {
      if (!startClockValid) return;
      settings = { ...DEFAULT_SETTINGS, trimStart: clockSeconds!, trimEnd: Math.min(chosenSource.duration, clockSeconds! + 5) };
    }
    const controller = new AbortController(); previewRequest.current = controller;
    video.current?.pause(); setPreviewBusy(true); setPreviewError(""); setPreview(null);
    try {
      const result = await post<{ url: string; duration: number }>("/api/previews", { sourceId: chosenSource.id, settings }, controller.signal);
      if (!controller.signal.aborted) setPreview({ ...result, kind, sourceId: chosenSource.id, sourceStart: kind === "source" ? clockSeconds! : 0, label: kind === "short" ? "Short preview · first five seconds" : `Source sample · from ${formatSourceClock(clockSeconds!)}` });
    } catch (error) {
      if (!controller.signal.aborted) setPreviewError(error instanceof Error ? error.message : "The sample could not be rendered.");
    } finally {
      if (previewRequest.current === controller) { previewRequest.current = null; setPreviewBusy(false); }
    }
  };
  const render = async () => {
    if (!targets.length || rendering) return;
    const invalid = targets.map(item => ({ draft: item, result: validateShortDraft({ ...item, autoFocus: false }, sources.find(source => source.id === item.sourceId)) })).find(item => item.result.errors.length);
    if (invalid) { selectDraft(invalid.draft); setError(`${invalid.draft.title || "Untitled short"}: ${invalid.result.errors[0]}`); return; }
    setRendering(true); setError("");
    try {
      const prepared: ShortDraft[] = [];
      for (const item of targets) {
        if (!item.autoFocus || item.fit !== "crop" || item.focusAnalysis?.signature === shortFocusSignature(item)) { prepared.push(item); continue; }
        const cuts = validateShortDraft({ ...item, autoFocus: false }, sources.find(source => source.id === item.sourceId)).settings!.segments!;
        const result = await post<FocusResult>("/api/speaker-focus", { sourceId: item.sourceId, cuts, seed: item.focalPoint, mode: item.focusMode || "face" });
        const ready: ShortDraft = { ...item, cuts: item.cuts.map(({ focusTrack: _previous, ...cut }, index) => ({ ...cut,
          focusTrack: result.tracks.find(track => track.cutIndex === index)?.keyframes })),
          focusAnalysis: { signature: shortFocusSignature(item), status: result.status, reason: result.reason, multipleFaces: result.multipleFaces } };
        prepared.push(ready);
        setDrafts(current => current.map(value => value.id === ready.id && shortFocusSignature(value) === shortFocusSignature(item) ? ready : value));
      }
      const checked = prepared.map(item => ({ draft: item, result: validateShortDraft(item, sources.find(source => source.id === item.sourceId)) }));
      const failure = checked.find(item => !item.result.settings);
      if (failure) throw new Error(`${failure.draft.title}: ${failure.result.errors[0]}`);
      const result = await post<{ jobs: RenderJob[] }>("/api/jobs", {
        items: checked.map(({ draft, result }) => ({ sourceId: draft.sourceId, title: draft.title.trim(), settings: result.settings })), variants: 1, randomize: false,
      });
      onQueued(result.jobs); onNotice(`${result.jobs.length} short${result.jobs.length === 1 ? "" : "s"} queued. Your timestamp drafts are saved.`, "success");
    } catch (error) { setError(error instanceof Error ? error.message : "The shorts could not be queued."); }
    finally { setRendering(false); }
  };
  const reconnect = (item: ShortDraft, chosenSource: VideoSource) => {
    const next = reconnectShortDraft(item, chosenSource);
    setDrafts(current => current.map(value => value.id === item.id ? next : value)); selectDraft(next);
    onNotice(`“${item.title}” reconnected to ${chosenSource.name}. Check its timestamps before rendering.`, "info");
  };
  const sourceAspect = source ? source.width / source.height : 16 / 9;
  const manualPoint = currentCut?.focalPoint || draft?.focalPoint || { x: 0.5, y: 0.5 };
  const trackedPoint = draft?.autoFocus && draft.fit === "crop" && focusReady
    ? focusPointAt(currentCut?.focusTrack, playhead, manualPoint) : manualPoint;
  const focalPoint = frozenFocus?.context === focusContext ? frozenFocus.point : trackedPoint;
  const crop = shortCropGuide(draftSource ?? source ?? { width: 1920, height: 1080 }, draft?.aspect ?? "9:16", draft?.zoom ?? 1, focalPoint, draft?.resolution ?? "1080");
  const travelPercent = (value: number, min: number, max: number) => max > min
    ? Math.round(Math.max(0, Math.min(1, (value - min) / (max - min))) * 100) : 50;
  const positionX = crop.canMoveX ? travelPercent(focalPoint.x, crop.minX, crop.maxX) : 50;
  const positionY = crop.canMoveY ? travelPercent(focalPoint.y, crop.minY, crop.maxY) : 50;
  const cropEditingAvailable = active && !!draft && !!draftSource && draftSource.id === source?.id && !rendering;
  const positionFrame = (point: FocalPoint) => {
    if (!draft || !cropEditingAvailable) return;
    // Manual framing applies to the whole short, replacing any per-cut override.
    updateDraft({ focalPoint: point, autoFocus: false, focusAnalysis: undefined,
      cuts: draft.cuts.map(({ focalPoint: _point, focusTrack: _track, ...cut }) => cut) });
  };
  const positionSubject = (axis: "x" | "y", percent: number) => {
    if (!draft || !cropEditingAvailable) return;
    if (axis === "x" ? !crop.canMoveX : !crop.canMoveY) return;
    const min = axis === "x" ? crop.minX : crop.minY;
    const max = axis === "x" ? crop.maxX : crop.maxY;
    if (max <= min) return;
    const point = { ...focalPoint, [axis]: min + percent / 100 * (max - min) };
    positionFrame(point);
  };

  return <div className="shorts-workspace" hidden={!active}>
    <ClipDiscovery source={source} active={active} remaining={MAX_SHORTS - drafts.length} onKeep={clips => {
      if (!source) return;
      const added = clips.slice(0, MAX_SHORTS - drafts.length).map(clip => ({
        ...createShortDraft(source, crypto.randomUUID(), crypto.randomUUID(), clip.start), title: clip.title,
        cuts: [{ id: crypto.randomUUID(), start: formatSourceClock(clip.start), end: formatSourceClock(clip.end) }],
      }));
      setDrafts(current => [...current, ...added].slice(0, MAX_SHORTS));
      if (added[0]) { setActiveId(added[0].id); seek(clips[0].start); }
    }} />
    <section className="shorts-player panel">
      <div className="panel-heading"><h2><Play size={16} /> Source preview</h2><span className="shorts-kicker">SOURCE CLOCK</span></div>
      {source ? <>
        <div className="shorts-viewer">
          <div className="shorts-source-frame" style={{ aspectRatio: sourceAspect, maxWidth: `${500 * sourceAspect}px` }}>
            <video key={source.id} ref={video} src={source.url} poster={source.thumbnailUrl} controls preload="metadata" playsInline
              onError={() => setCodecError(true)} onPlay={() => { clockOwner.current = "source"; sampleVideo.current?.pause(); }} onSeeking={() => { clockOwner.current = "source"; }}
              onLoadedMetadata={() => { if (video.current && playhead > 0) video.current.currentTime = playhead; }}
              onTimeUpdate={() => { if (!video.current || clockEditing || codecError || clockOwner.current !== "source") return; const time = Math.min(source.duration, video.current.currentTime); setPlayhead(time); setClock(formatSourceClock(time)); }} />
            {draftSource?.id === source.id && draft?.fit === "crop" && (!draft.layout || draft.layout === "single") && !codecError && <CropDragOverlay
              key={`${source.id}:${draft.id}:${currentCut?.id}:${currentCut?.start}:${currentCut?.end}:${draft.aspect}:${draft.zoom}:${draft.resolution}`}
              videoRef={video} source={source} crop={crop} label={draft.aspect === "original" ? "Source frame" : `${draft.aspect} crop`}
              disabled={!cropEditingAvailable} onChange={positionFrame}
              onDragStateChange={dragging => { if (dragging) { video.current?.pause(); setFrozenFocus({ context: focusContext, point: focalPoint }); } else setFrozenFocus(null); }} />}
          </div>
        </div>
        <div className="shorts-player-body">
          <div className="shorts-source-description"><strong title={source.name}>{source.name}</strong><span>{source.width} × {source.height} · {formatSourceClock(source.duration)}</span></div>
          {codecError && <p className="shorts-message" role="status">This browser cannot play the source format. Enter a timestamp and render a five-second sample to inspect any moment. Your full export uses the original video.</p>}
          <label className="shorts-scrubber"><span className="visually-hidden">Source position</span><input type="range" min={0} max={source.duration} step={0.001} value={playhead} onChange={event => seek(event.target.valueAsNumber)} style={{ "--range-fill": `${playhead / source.duration * 100}%` } as CSSProperties} /></label>
          <div className="shorts-clock-row"><label htmlFor="shorts-source-clock">Source timestamp<input id="shorts-source-clock" className="shorts-clock" value={clock} inputMode="decimal" spellCheck={false} aria-invalid={!clockValid} onFocus={() => setClockEditing(true)} onChange={event => setClock(event.target.value)} onBlur={() => { setClockEditing(false); if (clockValid) seek(clockSeconds!); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label><button className="secondary-button" disabled={!clockValid} onClick={() => seek(clockSeconds!)}>Go to time<ChevronRight size={14} /></button></div>
          {!clockValid && <p className="shorts-error" role="alert">Enter a timestamp inside this video: HH:MM:SS.mmm or seconds.</p>}
          <div className="shorts-sample-action"><button className="text-button" disabled={!engineReady || !startClockValid || previewBusy} onClick={() => void renderPreview("source")}><Play size={13} />Render sample at this time</button><span>5 seconds · up to 720p</span></div>
        </div>
      </> : <div className="shorts-empty"><Clapperboard size={30} /><h3>A long video. Your best moments.</h3><p>Import a video from the source panel, then choose the timestamps that belong in your short.</p></div>}
      {(previewBusy || preview || previewError) && <div className="shorts-rendered-sample">
        {previewBusy ? <div className="shorts-sample-status"><LoaderCircle size={18} className="spin" /><span>Rendering your five-second sample…</span><button className="icon-button" aria-label="Cancel short preview" onClick={() => { previewRequest.current?.abort(); previewRequest.current = null; setPreviewBusy(false); }}><X size={16} /></button></div> : preview ? <><div className="shorts-sample-status"><strong>{preview.label}</strong><button className="icon-button" aria-label="Close short preview" onClick={() => setPreview(null)}><X size={16} /></button></div><video ref={sampleVideo} key={preview.url} src={preview.url} controls playsInline preload="metadata" onPlay={() => { clockOwner.current = "sample"; video.current?.pause(); }} onSeeking={() => { clockOwner.current = "sample"; }} onTimeUpdate={() => { if (preview.kind !== "source" || clockEditing || !sampleVideo.current || clockOwner.current !== "sample") return; const time = Math.min(source?.duration ?? Infinity, preview.sourceStart + sampleVideo.current.currentTime); setPlayhead(time); setClock(formatSourceClock(time)); }} /><p>Rendered framing, sound and cleanup. Export keeps your chosen resolution.</p></> : <p className="shorts-error" role="alert">{previewError}</p>}
      </div>}
    </section>

    <section className="shorts-editor panel">
      <div className="panel-heading"><h2><Scissors size={16} /> Build a short</h2><button className="secondary-button" disabled={!source || drafts.length >= MAX_SHORTS} onClick={addDraft}><Plus size={15} />New short</button></div>
      {draft ? <div className="shorts-editor-body">
        <FinishingPresets mode="shorts" settings={draft} disabled={rendering} onApply={patch => updateDraft({ ...patch, focusAnalysis: undefined })}
          onApplySelected={selectedIds.length ? patch => setDrafts(current => current.map(item => selectedIds.includes(item.id) ? { ...item, ...patch, focusAnalysis: undefined, updatedAt: new Date().toISOString() } : item)) : undefined} />
        <div className="shorts-title-row"><label htmlFor="shorts-title">Short name<input id="shorts-title" value={draft.title} maxLength={100} placeholder="Name this moment" onChange={event => updateDraft({ title: event.target.value })} /></label><button className="icon-button" title="Duplicate short" aria-label="Duplicate short" disabled={drafts.length >= MAX_SHORTS} onClick={duplicate}><Copy size={16} /></button></div>
        {!draftSource && <div className="shorts-message"><strong>Source unavailable</strong><p>Reimport {draft.sourceName}, then reconnect this draft. Your sequences are saved.</p>{matchingShortSource(draft, sources) ? <button className="secondary-button" onClick={() => reconnect(draft, matchingShortSource(draft, sources)!)}><Link2 size={14} />Reconnect matching video</button> : source && <button className="secondary-button" onClick={() => reconnect(draft, source)}><Link2 size={14} />Reconnect to selected source</button>}</div>}
        <div className="shorts-section-label"><h3>Sequences</h3><span>{draft.cuts.length} / {MAX_SHORT_CUTS}</span></div>
        <p className="shorts-helper">Source timestamps. Sequences play in the order below. Use the source preview to find a moment, then set the selected sequence here.</p>
          <div className="shorts-mark-actions"><button className="secondary-button" disabled={!currentCut || !startClockValid || draftSource?.id !== source.id} onClick={() => mark("start")}><Scissors size={14} />Set start at playhead</button><button className="secondary-button" disabled={!currentCut || !clockValid || draftSource?.id !== source.id} onClick={() => mark("end")}><Scissors size={14} />Set end at playhead</button></div>
        <ol className="shorts-cut-list">{draft.cuts.map((cut, index) => {
          const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
          const invalid = start === null || end === null || end <= start + 0.04 || (!!draftSource && (start >= draftSource.duration || end > draftSource.duration + 0.001));
          return <li key={cut.id} className={`shorts-cut ${currentCut?.id === cut.id ? "active" : ""}`} onFocus={() => setCutId(cut.id)}>
            <div className="shorts-cut-heading"><button className="shorts-cut-select" aria-pressed={currentCut?.id === cut.id} onClick={() => setCutId(cut.id)}><span>{String(index + 1).padStart(2, "0")}</span>Sequence {index + 1}</button><div><button className="icon-button" aria-label={`Move sequence ${index + 1} earlier`} disabled={index === 0} onClick={() => moveCut(index, -1)}><ArrowUp size={14} /></button><button className="icon-button" aria-label={`Move sequence ${index + 1} later`} disabled={index === draft.cuts.length - 1} onClick={() => moveCut(index, 1)}><ArrowDown size={14} /></button><button className="icon-button" aria-label={`Remove sequence ${index + 1}`} disabled={draft.cuts.length === 1} onClick={() => updateDraft({ cuts: draft.cuts.filter(item => item.id !== cut.id) })}><Trash2 size={14} /></button></div></div>
            <div className="shorts-timestamp-pair"><label htmlFor={`short-start-${cut.id}`}>Start<input id={`short-start-${cut.id}`} aria-label={`Sequence ${index + 1} start`} value={cut.start} maxLength={32} spellCheck={false} aria-invalid={invalid} onChange={event => updateCut(cut.id, { start: event.target.value })} /></label><span aria-hidden="true">→</span><label htmlFor={`short-end-${cut.id}`}>End<input id={`short-end-${cut.id}`} aria-label={`Sequence ${index + 1} end`} value={cut.end} maxLength={32} spellCheck={false} aria-invalid={invalid} onChange={event => updateCut(cut.id, { end: event.target.value })} /></label></div>
            <div className="shorts-cut-footer">{invalid ? <span className="shorts-error">Check timestamps and sequence length.</span> : <span>{durationLabel(end! - start!)}</span>}<button className="text-button" disabled={start === null || !draftSource || draftSource.id !== source?.id || start >= draftSource.duration} onClick={() => { setCutId(cut.id); seek(start!); }}>Go to start<ChevronRight size={12} /></button></div>
          </li>;
        })}</ol>
        <button className="secondary-button shorts-add-sequence" disabled={!draftSource || draft.cuts.length >= MAX_SHORT_CUTS} onClick={addCut}><Plus size={14} />Add sequence at playhead</button>
        <details className="shorts-output-settings" open>
          <summary>Frame &amp; quality<span>{draft.aspect === "original" ? "Original" : draft.aspect} · {draft.resolution === "source" ? "Source" : `${draft.resolution}p`}</span></summary>
          <div className="shorts-settings-grid"><label className="shorts-full-width">Layout<select value={draft.layout || "single"} onChange={event => updateDraft({ layout: event.target.value as ShortDraft["layout"], fit: "crop", autoFocus: false, focusAnalysis: undefined,
            ...(event.target.value === "split" ? { focalPoint: { x: 0.25, y: 0.5 }, secondaryFocalPoint: { x: 0.75, y: 0.5 } } : {}) })}><option value="single">Single frame</option><option value="split">Two people · stacked</option><option value="presentation">Full scene + speaker</option></select></label><label>Format<select value={draft.aspect} onChange={event => updateDraft({ aspect: event.target.value as ShortDraft["aspect"] })}><option value="9:16">Portrait · 9:16</option><option value="1:1">Square · 1:1</option><option value="4:5">Portrait · 4:5</option><option value="16:9">Landscape · 16:9</option><option value="original">Original format</option></select></label><label>Export quality<select value={draft.resolution} onChange={event => updateDraft({ resolution: event.target.value as ShortDraft["resolution"] })}><option value="1080">1080p · Full HD</option><option value="720">720p · HD</option><option value="source">Source resolution</option></select></label><label className="shorts-full-width">Fit the frame<select disabled={draft.layout === "split" || draft.layout === "presentation"} value={draft.fit} onChange={event => updateDraft({ fit: event.target.value as ShortDraft["fit"], ...(event.target.value !== "crop" ? { zoom: 1 } : {}) })}><option value="crop">Fill frame · crop sides</option><option value="blur">Keep full shot · blurred background</option><option value="contain">Keep full shot · black background</option></select></label></div>
          {draft.layout === "split" && <div className="shorts-focal-controls"><p className="shorts-helper">Both panels use this source. Set each person’s center, then preview the rendered layout.</p>
            <Slider label="Top person · horizontal" min={0} max={100} step={1} unit="%" value={Math.round(draft.focalPoint.x * 100)} defaultValue={25} onChange={value => updateDraft({ focalPoint: { ...draft.focalPoint, x: value / 100 } })} />
            <Slider label="Top person · vertical" min={0} max={100} step={1} unit="%" value={Math.round(draft.focalPoint.y * 100)} defaultValue={50} onChange={value => updateDraft({ focalPoint: { ...draft.focalPoint, y: value / 100 } })} />
            <Slider label="Bottom person · horizontal" min={0} max={100} step={1} unit="%" value={Math.round((draft.secondaryFocalPoint?.x ?? 0.75) * 100)} defaultValue={75} onChange={value => updateDraft({ secondaryFocalPoint: { x: value / 100, y: draft.secondaryFocalPoint?.y ?? 0.5 } })} />
            <Slider label="Bottom person · vertical" min={0} max={100} step={1} unit="%" value={Math.round((draft.secondaryFocalPoint?.y ?? 0.5) * 100)} defaultValue={50} onChange={value => updateDraft({ secondaryFocalPoint: { x: draft.secondaryFocalPoint?.x ?? 0.75, y: value / 100 } })} />
          </div>}
          {draft.layout === "presentation" && <div className="shorts-focal-controls"><p className="shorts-helper">The full scene sits above a close-up from the same source. Preview to check that the important content stays legible.</p>
            <Slider label="Speaker center · horizontal" min={0} max={100} step={1} unit="%" value={Math.round(draft.focalPoint.x * 100)} defaultValue={50} onChange={value => updateDraft({ focalPoint: { ...draft.focalPoint, x: value / 100 } })} />
            <Slider label="Speaker center · vertical" min={0} max={100} step={1} unit="%" value={Math.round(draft.focalPoint.y * 100)} defaultValue={50} onChange={value => updateDraft({ focalPoint: { ...draft.focalPoint, y: value / 100 } })} />
          </div>}
          {draft.fit === "crop" && (!draft.layout || draft.layout === "single") && <div className="shorts-focal-controls">
            <div className="shorts-focus-card">
              <label className="shorts-check-option shorts-focus-toggle"><input type="checkbox" checked={draft.autoFocus === true} disabled={!cropEditingAvailable || !engineReady}
                onChange={event => updateDraft({ autoFocus: event.target.checked })} /><span><strong>Auto center speaker <em>Local</em></strong><small>Choose face following or detect who is speaking from audio and video.</small></span></label>
              <label className="shorts-helper">Tracking method<select value={draft.focusMode || "face"} onChange={event => updateDraft({ focusMode: event.target.value as "face" | "speaker", focusAnalysis: undefined })}><option value="face">Follow selected face · Free</option><option value="speaker">Follow active speaker · Free, local AI</option></select></label>
              <div className="shorts-focus-status" role="status" aria-live="polite">
                {draft.autoFocus ? <>
                  {focusBusyId === draft.id || !focusReady ? <p><LoaderCircle size={13} className={focusBusyId === draft.id ? "spin" : ""} />{focusBusyId === draft.id ? draft.focusMode === "speaker" ? "Comparing speech and face motion locally…" : "Finding the face in your selected sequences…" : "Complete valid timestamps to prepare automatic centering."}</p>
                    : <><p>{draft.focusAnalysis?.status === "tracked" ? "Framing is ready. Play the source to see the crop follow the face."
                      : draft.focusAnalysis?.status === "partial" ? "Framing is ready where a face was found. Other sequences keep your manual position."
                      : draft.focusAnalysis?.status === "no-face" ? "No clear face was found. Your manual framing will be used." : "Automatic centering is unavailable. Your manual framing will be used."}</p>
                      {draft.focusAnalysis?.reason && <p>{draft.focusAnalysis.reason}</p>}
                      {draft.focusAnalysis?.multipleFaces && draft.focusMode !== "speaker" && <p>Several faces were visible. This follows the face nearest your starting crop; it does not identify the person speaking.</p>}
                      {draft.focusAnalysis?.status !== "tracked" && <button className="text-button" type="button" disabled={!cropEditingAvailable || !engineReady} onClick={() => { updateDraft({ focusAnalysis: undefined }); setFocusRetry(value => value + 1); }}>Retry automatic centering<ArrowRight size={13} /></button>}</>}
                  <p>Dragging the frame or changing its position switches automatic centering off.</p>
                </> : <p>Off · Your manual frame stays fixed. Analysis runs on your computer.</p>}
              </div>
            </div>
            <p className="shorts-framing-scope">Drag the orange frame on the video, or use these controls. Position changes apply to every sequence.</p>
            <Slider label="Crop zoom" min={1} max={2} step={0.01} unit="×" value={draft.zoom ?? 1} defaultValue={1} disabled={!cropEditingAvailable} onChange={zoom => updateDraft({ zoom })}
              hint="Zoom in to leave room to move the frame. More zoom keeps less of the original picture." />
            <Slider label="Subject left / right" min={0} max={100} step={1} unit="%" value={positionX} defaultValue={50} disabled={!cropEditingAvailable || !crop.canMoveX}
              onChange={percent => positionSubject("x", percent)} hint={crop.canMoveX ? "0% selects the left edge; 100% selects the right edge." : "The full width is already visible. Increase Crop zoom to move left or right."} />
            <Slider label="Subject up / down" min={0} max={100} step={1} unit="%" value={positionY} defaultValue={50} disabled={!cropEditingAvailable || !crop.canMoveY}
              onChange={percent => positionSubject("y", percent)} hint={crop.canMoveY ? "0% selects the top edge; 100% selects the bottom edge." : "The full height is already visible. Increase Crop zoom to move up or down."} />
            <p className="shorts-helper">The outlined area updates as you adjust the frame. Preview this short to see the cropped result.</p>
          </div>}
          <label className="shorts-check-option"><input type="checkbox" checked={draft.normalizeAudio} onChange={event => updateDraft({ normalizeAudio: event.target.checked })} /><span><strong>Even out audio</strong><small>Normalize the selected sequences.</small></span></label>
          <label className="shorts-check-option"><input type="checkbox" checked={draft.qualityCleanup} onChange={event => updateDraft({ qualityCleanup: event.target.checked })} /><span><strong>Gentle cleanup <em>Free</em></strong><small>Reduce noise and sharpen lightly on your computer.</small></span></label>
          <p className="shorts-helper">1080p portrait exports are 1080 × 1920. Enlarging or cleaning up footage cannot restore missing detail.</p>
        </details>
        <div className="shorts-total"><span>Short duration</span><strong>{durationLabel(validation?.duration || 0)}</strong></div>
        {!!validation?.errors.length && <div className="shorts-error" role="alert">{validation.errors[0]}</div>}
        {(validation?.duration || 0) > 180 && <p className="shorts-message">This cut runs over three minutes. Check the length you want before posting.</p>}
        <button className="secondary-button shorts-preview-button" disabled={!engineReady || !validation?.settings || previewBusy} onClick={() => void renderPreview("short")}><Play size={14} />Preview this short<span>5s</span></button>
      </div> : <div className="shorts-empty"><Scissors size={28} /><h3>Keep the part that matters.</h3><p>Create a short, set its start and end, then add another sequence if your story needs it.</p></div>}
    </section>

    <section className="shorts-collection panel">
      <div className="panel-heading"><h2><Clapperboard size={16} />Your short clips<span className="count-pill">{drafts.length}</span></h2><span className={`shorts-save-state ${savingError ? "shorts-error" : ""}`}>{savingError ? "Browser storage full · keep this tab open" : <><Check size={13} />Saved in this browser</>}</span></div>
      <div className="shorts-collection-body">
        {drafts.length ? <div className="shorts-draft-list">{drafts.map(item => {
          const source = sources.find(source => source.id === item.sourceId);
          const result = validateShortDraft(item, source);
          return <div key={item.id} className={`shorts-draft-row ${item.id === draft?.id ? "active" : ""}`}>
            <label className="shorts-select-check"><span className="visually-hidden">Select {item.title || "Untitled short"} for rendering</span><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={event => setSelectedIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /></label>
            <button className="shorts-draft-main" onClick={() => selectDraft(item)}><strong>{item.title || "Untitled short"}</strong><span title={item.sourceName}>{item.sourceName}</span></button>
            <span className={`shorts-draft-status ${result.errors.length ? "needs-review" : ""}`}>{!source ? "Reconnect source" : result.errors.length ? "Check timestamps" : `${item.cuts.length} sequence${item.cuts.length === 1 ? "" : "s"} · ${durationLabel(result.duration)}`}</span>
            <button className="icon-button" aria-label={`Delete ${item.title || "untitled short"} draft`} onClick={() => { setDrafts(current => current.filter(value => value.id !== item.id)); setSelectedIds(current => current.filter(id => id !== item.id)); if (draft?.id === item.id) setActiveId(null); }}><Trash2 size={15} /></button>
          </div>;
        })}</div> : <p className="shorts-collection-empty">Every short you create appears here. Select clips from several source videos and render them together.</p>}
        <div className="shorts-collection-actions">{drafts.length > 0 && <button className="text-button" onClick={() => setSelectedIds(selectedIds.length === drafts.length ? [] : drafts.map(item => item.id))}>{selectedIds.length === drafts.length ? "Clear selection" : "Select all shorts"}</button>}</div>
      </div>
      <div className="shorts-render-bar"><div><strong>From long-form to ready to share.</strong><p>Your original file stays intact. Each short becomes its own MP4.</p></div><div className="shorts-render-controls"><label htmlFor="shorts-render-scope">Render scope<select id="shorts-render-scope" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="current">This short</option><option value="selected">Selected shorts ({selectedIds.length})</option><option value="all">All shorts ({drafts.length})</option></select></label><button className="primary-button" disabled={!engineReady || !targets.length || rendering || !!focusBusyId || (scope === "current" && !validation?.settings)} onClick={() => void render()}>{rendering ? <LoaderCircle size={16} className="spin" /> : <Clapperboard size={16} />}<span>{rendering ? "Preparing…" : `Render ${targets.length === 1 ? "this short" : `${targets.length} shorts`}`}</span><ArrowRight size={15} /></button></div></div>
      {error && <p className="shorts-batch-error shorts-error" role="alert">{error}</p>}
    </section>
  </div>;
}
