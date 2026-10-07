import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { Brush, Eraser, LoaderCircle, MousePointer2, Play, Pause, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { DEFAULT_SETTINGS, type VideoSource } from "../shared/types";
import { activeRemovalMasks, DEFAULT_WATERMARK_REMOVAL, DEFAULT_WATERMARK_FEATHER, featherMask, MAX_MASK_STROKES, MAX_STROKE_POINTS, MAX_WATERMARK_MASKS,
  rasterizeMask, watermarkRemovalSchema, type MaskPoint, type MaskStroke, type WatermarkMask, type WatermarkRemoval } from "../shared/watermark-removal";
import { apiRequest } from "./api-client";
import ProblemNotice from "./ProblemNotice";
import "./watermark-removal.css";

type Tool = "rect" | "brush" | "erase";
const stamp = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
const newMask = (start: number, end: number): WatermarkMask => ({ id: crypto.randomUUID(), start, end, fill: "lama", strokes: [] });

function TimeField({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (n: number) => boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Number(value.toFixed(3)))), [value]);
  return <label>{label}<input type="number" min={0} max={max} step="0.01" value={text} onChange={event => {
    setText(event.target.value);
    if (event.target.value && Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber);
  }} onBlur={() => setText(String(Number(value.toFixed(3))))} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

/** One controller places controls in the settings column and the canvas in the main preview. */
export function useWatermarkRemoval({ value, onChange, source, workspaceKey }: {
  value?: WatermarkRemoval; onChange: (value: WatermarkRemoval) => void; source?: VideoSource; workspaceKey: string;
}) {
  const removal = value ?? DEFAULT_WATERMARK_REMOVAL;
  const editorHelpId = useId();
  const [editing, setEditing] = useState(false), [tool, setTool] = useState<Tool>("brush"), [size, setSize] = useState(.04);
  const [maskId, setMaskId] = useState(""), [time, setTime] = useState(0), [seek, setSeek] = useState({ time: 0, token: 0 });
  const [error, setError] = useState("");
  const history = useRef<WatermarkRemoval[]>([]);
  const mask = (removal.mode === "fixed" ? removal.masks[0] : removal.masks.find(item => item.id === maskId)) ?? removal.masks[0];
  useEffect(() => { history.current = []; setEditing(false); setMaskId(""); setTime(0); setError(""); setSeek({ time: 0, token: 0 }); }, [source?.id, workspaceKey]);
  useEffect(() => { if (!removal.enabled) setEditing(false); }, [removal.enabled]);
  const update = (next: WatermarkRemoval) => {
    const parsed = watermarkRemovalSchema.safeParse(next);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || "Check the marked areas."); return; }
    history.current = [...history.current.slice(-59), removal];
    setError(""); onChange(parsed.data);
  };
  const patchMask = (change: Partial<WatermarkMask>) => {
    if (mask) update({ ...removal, masks: removal.masks.map(item => item.id === mask.id ? { ...item, ...change } : item) });
  };
  const seekTo = (at: number) => { setTime(at); setSeek(current => ({ time: at, token: current.token + 1 })); };
  const open = (at = time) => {
    setEditing(true);
    seekTo(at);
    if (!removal.masks.length && source) update({ ...removal, masks: [newMask(0, source.duration)] });
    requestAnimationFrame(() => document.querySelector('.preview-panel')?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const selectMask = (item: WatermarkMask) => { setMaskId(item.id); open(item.start); };
  const controls = <section className="watermark-controls" aria-label="Watermark removal">
    <label className="watermark-toggle"><input type="checkbox" checked={removal.enabled} disabled={!source} onChange={event => {
      const enabled = event.target.checked;
      update({ ...removal, enabled, masks: enabled && !removal.masks.length && source ? [newMask(0, source.duration)] : removal.masks });
      setEditing(enabled);
      if (enabled) seekTo(time);
    }} /><span><strong>Watermark removal</strong><small>Brush away a logo, timestamp or unwanted overlay.</small></span></label>
    {!source && <p>Add a video to mark an area.</p>}
    {removal.enabled && source && <>
      <p>Saved for this video only. Mark on the original picture before cropping or adding black bands.</p>
      <label>Removal timing<select value={removal.mode} onChange={event => update({ ...removal, mode: event.target.value as WatermarkRemoval["mode"] })}>
        <option value="fixed">Whole video · fixed area</option><option value="timed">Time ranges · only while visible</option>
      </select></label>
      {removal.mode === "fixed" && <p>This removes the area on every frame, even after the mark disappears. Use a time range for a temporary label.</p>}
      {removal.mode === "fixed" && removal.masks.length > 1 && <p>Whole video uses Area 1. Your other areas are kept for Time ranges.</p>}
      {removal.mode === "timed" && <div className="watermark-ranges">
        <p>Times refer to the original video. Add a range whenever the mark moves; areas stay fixed within each range.</p>
        {removal.masks.map((item, index) => <div key={item.id} className="watermark-range">
          <button type="button" aria-pressed={item.id === mask?.id} onClick={() => selectMask(item)}>Area {index + 1} <span>{stamp(item.start)}–{stamp(item.end)}</span></button>
          <button type="button" aria-label={`Delete area ${index + 1}`} onClick={() => update({ ...removal, masks: removal.masks.filter(entry => entry.id !== item.id) })}><Trash2 size={14} /></button>
        </div>)}
        <button type="button" className="secondary-button" disabled={removal.masks.length >= MAX_WATERMARK_MASKS} onClick={() => {
          const start = Math.min(time, Math.max(0, source.duration - .1));
          const next = newMask(start, Math.min(source.duration, start + 2));
          update({ ...removal, masks: [...removal.masks, next] }); setMaskId(next.id); seekTo(start); setEditing(true);
        }}><Plus size={14} />Add area at playhead</button>
        {mask && <div className="watermark-time-fields">
          <TimeField label="Area start (seconds)" value={mask.start} max={source.duration} onChange={n => { if (n < 0 || n >= mask.end) return false; patchMask({ start: n }); seekTo(n); return true; }} />
          <TimeField label="Area end (seconds)" value={mask.end} max={source.duration} onChange={n => { if (n <= mask.start || n > source.duration) return false; patchMask({ end: n }); return true; }} />
        </div>}
      </div>}
      {mask && <>
        <label>Area fill<select value={mask.fill ?? "surroundings"} onChange={event => patchMask(event.target.value === "reference"
          ? { fill: "reference", referenceTime: mask.referenceTime ?? Math.min(time, Math.max(0, source.duration - 1 / (source.fps || 30))) }
          : { fill: event.target.value as "lama" | "surroundings" })}>
          <option value="lama">AI reconstruction · LaMa (local)</option>
          <option value="surroundings">Blend surrounding pixels · fast</option><option value="reference">Copy from a clean frame</option>
        </select></label>
        {mask.fill === "lama" && <p>Rebuilds the marked background with free, local AI. Slower than blending; fine details and moving backgrounds can still change or flicker. Preview a short sample first.</p>}
        {mask.fill === "reference" && <>
          <p>Use real background detail from a nearby frame where this area is clear. Best for short removals on a steady background; the patch does not follow camera or subject movement.</p>
          <TimeField label="Clean frame (source seconds)" value={mask.referenceTime ?? 0} max={Math.max(0, source.duration - 1 / (source.fps || 30))}
            onChange={n => { if (n < 0 || n >= source.duration) return false; patchMask({ referenceTime: n }); return true; }} />
          <button type="button" className="secondary-button" onClick={() => open(mask.referenceTime ?? 0)}>View clean frame</button>
          {editing && <button type="button" className="secondary-button" onClick={() => {
            patchMask({ referenceTime: Math.min(time, Math.max(0, source.duration - 1 / (source.fps || 30))) }); seekTo(mask.start);
          }}>Use playhead as clean frame</button>}
        </>}
      </>}
      <label>Edge softness <output>{Math.round((removal.feather ?? DEFAULT_WATERMARK_FEATHER) * 1000) / 10}%</output>
        <input aria-label="Watermark edge softness" type="range" min={0} max={.03} step={.0025} value={removal.feather ?? DEFAULT_WATERMARK_FEATHER}
          onChange={event => update({ ...removal, feather: event.target.valueAsNumber })} />
      </label>
      <p>Blends a narrow margin around the selection. The selected mark stays fully covered.</p>
      <button type="button" className="secondary-button" aria-describedby={editorHelpId} onClick={() => editing ? setEditing(false) : open()}>
        {editing ? <X size={16} /> : <Brush size={16} />}{editing ? "Close watermark editor" : "Open watermark editor"}
      </button>
      <p id={editorHelpId}>{editing
        ? "Areas save automatically as you draw. Closing returns to the main preview; watermark removal stays enabled for export."
        : "Open the editor to mark or adjust areas and preview the cleaned result."}</p>
      {editing && <>
        <button type="button" className="secondary-button" disabled={!mask || time <= mask.start || time >= source.duration} onClick={() => {
          if (mask) update({ ...removal, mode: "timed", masks: removal.masks.map(item => item.id === mask.id ? { ...item, end: time } : item) });
        }}>Stop this area at playhead</button>
        <div className="watermark-tools" role="group" aria-label="Watermark marking tools">
          {([["rect", "Select", MousePointer2], ["brush", "Brush", Brush], ["erase", "Erase", Eraser]] as const).map(([id, label, Icon]) =>
            <button key={id} type="button" aria-pressed={tool === id} onClick={() => setTool(id)}><Icon size={17} />{label}</button>)}
          <button type="button" disabled={!history.current.length} onClick={() => { const previous = history.current.pop(); if (previous) { setError(""); onChange(previous); } }}><RotateCcw size={17} />Undo</button>
        </div>
        <p>{tool === "rect" ? "Drag a box on the video. Drag its center to move it or a corner to resize it." : tool === "brush" ? "Paint over the mark. Pause or scrub to check its position." : "Brush over a selection to remove it from the mask."}</p>
        {tool !== "rect" && <label>Brush size <output>{Math.round(size * 100)}%</output><input aria-label="Watermark brush size" type="range" min={.005} max={.2} step={.005} value={size} onChange={event => setSize(event.target.valueAsNumber)} /></label>}
        <button type="button" className="watermark-clear" disabled={!mask?.strokes.length} onClick={() => patchMask({ strokes: [] })}><Trash2 size={14} />Clear selected area</button>
      </>}
      <p>Cover the entire unwanted label, including its background. Preview the cleaned result before exporting.</p>
      {error && <ProblemNotice message={error} operation="Mark watermark" />}
    </>}
  </section>;
  return { controls, editing: editing && removal.enabled && !!source,
    preview: source ? <WatermarkWorkspace key={`${workspaceKey}-${source.id}`} source={source} value={removal} mask={mask}
      onStrokes={strokes => patchMask({ strokes })} tool={tool} size={size} seek={seek} onTime={setTime} onError={setError} /> : null };
}

function WatermarkWorkspace({ source, value, mask, onStrokes, tool, size, seek, onTime, onError }: {
  source: VideoSource; value: WatermarkRemoval; mask?: WatermarkMask; onStrokes: (strokes: MaskStroke[]) => void;
  tool: Tool; size: number; seek: { time: number; token: number }; onTime: (time: number) => void; onError: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [time, setTime] = useState(seek.time), [playing, setPlaying] = useState(false), [draft, setDraft] = useState<MaskStroke[] | null>(null);
  const [preview, setPreview] = useState<{ url: string; signature: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const gesture = useRef<{ id: number; start: MaskPoint; original: MaskStroke[]; strokes: MaskStroke[]; index: number; move?: MaskStroke; corner?: MaskPoint } | null>(null);
  const signature = JSON.stringify(value);
  const cleaned = preview?.signature === signature;
  const maskActive = !!mask && (value.mode === "fixed" || (time >= mask.start && time < mask.end));
  const aspect = source.width / source.height;
  const width = Math.round(Math.min(720, source.width)), height = Math.max(1, Math.round(width / aspect));
  const resetPreview = () => { setPreview(null); setPlaying(false); };
  const go = (at: number) => { if (video.current) video.current.currentTime = at; setTime(at); onTime(at); };
  useEffect(() => { setPreview(null); go(seek.time); }, [seek.token]);
  useEffect(() => { request.current?.abort(); request.current = null; setBusy(false); setPreview(null); setError(""); }, [signature]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { gesture.current = null; setDraft(null); }, [mask?.id, seek.token, tool]);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const pixels = new Uint8Array(width * height);
    for (const item of activeRemovalMasks(value, time)) {
      const raster = featherMask(rasterizeMask(item.id === mask?.id && draft ? draft : item.strokes, width, height), width, height,
        (value.feather ?? DEFAULT_WATERMARK_FEATHER) * Math.min(width, height));
      for (let i = 0; i < pixels.length; i++) pixels[i] = Math.max(pixels[i]!, Math.round(raster[i]! / 255 * (item.id === mask?.id ? 180 : 95)));
    }
    const image = context.createImageData(width, height);
    for (let i = 0; i < pixels.length; i++) { image.data[i * 4] = 235; image.data[i * 4 + 1] = 160; image.data[i * 4 + 2] = 95; image.data[i * 4 + 3] = pixels[i]!; }
    context.putImageData(image, 0, 0);
    const strokes = draft ?? mask?.strokes ?? [], last = strokes.at(-1);
    if (maskActive && tool === "rect" && last?.kind === "rect") {
      const [a, b] = last.points;
      context.strokeStyle = "white"; context.lineWidth = 2; context.setLineDash([5, 4]);
      context.strokeRect(a!.x * width, a!.y * height, (b!.x - a!.x) * width, (b!.y - a!.y) * height); context.setLineDash([]);
      context.fillStyle = "white";
      for (const x of [a!.x, b!.x]) for (const y of [a!.y, b!.y]) context.fillRect(x * width - 4, y * height - 4, 8, 8);
    }
  }, [signature, time, mask?.id, maskActive, draft, tool, width, height, cleaned]);
  const position = (event: PointerEvent<HTMLCanvasElement>): MaskPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    const round = (n: number) => Number(Math.max(0, Math.min(1, n)).toFixed(5));
    return { x: round((event.clientX - rect.left) / rect.width), y: round((event.clientY - rect.top) / rect.height) };
  };
  const start = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!maskActive || !mask || event.button !== 0 || gesture.current) return;
    event.preventDefault(); video.current?.pause();
    const p = position(event), original = mask.strokes, last = original.at(-1);
    let move: MaskStroke | undefined, corner: MaskPoint | undefined;
    if (tool === "rect" && last?.kind === "rect") {
      const [a, b] = last.points, rect = event.currentTarget.getBoundingClientRect();
      for (const x of [a!.x, b!.x]) for (const y of [a!.y, b!.y])
        if (Math.hypot((p.x - x) * rect.width, (p.y - y) * rect.height) < 12) corner = { x: x === a!.x ? b!.x : a!.x, y: y === a!.y ? b!.y : a!.y };
      if (!corner && p.x >= Math.min(a!.x, b!.x) && p.x <= Math.max(a!.x, b!.x) && p.y >= Math.min(a!.y, b!.y) && p.y <= Math.max(a!.y, b!.y)) move = last;
    }
    if (!move && !corner && original.length >= MAX_MASK_STROKES) { onError("Use Undo or clear an area before adding more brush strokes."); return; }
    const index = move || corner ? original.length - 1 : original.length;
    const strokes = [...original];
    if (!move && !corner) strokes.push({ kind: tool, size, points: tool === "rect" ? [p, p] : [p] });
    gesture.current = { id: event.pointerId, start: p, original, strokes, index, move, corner };
    event.currentTarget.setPointerCapture(event.pointerId); setDraft(strokes);
  };
  const draw = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const p = position(event), stroke = current.strokes[current.index]!;
    let points = stroke.points;
    if (current.move) {
      const xs = current.move.points.map(p => p.x), ys = current.move.points.map(p => p.y);
      const dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), p.x - current.start.x));
      const dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), p.y - current.start.y));
      points = current.move.points.map(a => ({ x: Number((a.x + dx).toFixed(5)), y: Number((a.y + dy).toFixed(5)) }));
    } else if (tool === "rect") points = [current.corner ?? current.start, p];
    else {
      const last = points.at(-1)!;
      if (points.length >= MAX_STROKE_POINTS || Math.hypot((p.x - last.x) * width, (p.y - last.y) * height) < 1) return;
      points = [...points, p];
    }
    const strokes = [...current.strokes]; strokes[current.index] = { ...stroke, points };
    current.strokes = strokes; setDraft(strokes);
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    draw(event); onStrokes(current.strokes); gesture.current = null; setDraft(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const renderPreview = async () => {
    if (request.current) return;
    video.current?.pause(); setError(""); setBusy(true);
    const controller = new AbortController(); request.current = controller;
    const start = Math.min(time, Math.max(0, source.duration - .1));
    try {
      const result = await apiRequest<{ url: string }>("/api/previews", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: source.id, settings: { ...DEFAULT_SETTINGS, aspect: "original", resolution: "source", watermarkRemoval: value,
          trimStart: start, trimEnd: Math.min(source.duration, start + 3) } }) });
      if (!controller.signal.aborted) setPreview({ url: result.url, signature });
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not preview removal."); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  };
  return <div className="watermark-workspace">
    <p className="watermark-view-label">{cleaned ? "CLEANED SAMPLE" : "MARK ORIGINAL · SOURCE TIME"}</p>
    <div className="watermark-picture" style={{ aspectRatio: aspect, width: `min(100%, calc(var(--watermark-height, 465px) * ${aspect}))` }}>
      <video key={cleaned ? preview!.url : source.id} ref={video} src={cleaned ? preview!.url : source.url} poster={cleaned ? undefined : source.thumbnailUrl}
        playsInline preload="metadata" controls={cleaned} aria-label={cleaned ? "Cleaned watermark preview" : "Watermark source video"}
        onLoadedMetadata={() => { if (!cleaned && video.current) video.current.currentTime = time; }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={event => { if (!cleaned) { setTime(event.currentTarget.currentTime); onTime(event.currentTarget.currentTime); } }}
        onError={() => setError("This video could not be played. Reload the source or render the sample again.")} />
      {!cleaned && <canvas ref={canvas} width={width} height={height} className={maskActive ? "" : "inactive"} aria-label="Paint watermark mask on video"
        onPointerDown={start} onPointerMove={draw} onPointerUp={finish} onPointerCancel={() => { gesture.current = null; setDraft(null); }} />}
    </div>
    {!cleaned && <>
      <div className="watermark-transport">
        <button type="button" aria-label={playing ? "Pause watermark video" : "Play watermark video"} onClick={() => { if (playing) video.current?.pause(); else void video.current?.play().catch(() => setError("The video could not start playing.")); }}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
        <output>{stamp(time)}</output><input type="range" aria-label="Watermark source timeline" min={0} max={source.duration} step={1 / source.fps} value={time} onChange={event => { video.current?.pause(); go(event.target.valueAsNumber); }} /><span>{stamp(source.duration)}</span>
      </div>
      <TimeField label="Go to source time (seconds)" value={time} max={source.duration} onChange={n => { if (n < 0 || n > source.duration) return false; video.current?.pause(); go(n); return true; }} />
      {!maskActive && <p>Select an area covering this timestamp, or add a new area at the playhead.</p>}
    </>}
    <div className="watermark-preview-actions">
      {cleaned ? <button type="button" className="secondary-button" onClick={resetPreview}>Back to marking</button>
        : busy ? <button type="button" className="secondary-button" onClick={() => request.current?.abort()}><LoaderCircle size={15} className="spin" />Cancel preview<X size={14} /></button>
          : <button type="button" className="secondary-button" disabled={!value.masks.some(item => item.strokes.length)} onClick={() => void renderPreview()}>Preview removal · 3s</button>}
    </div>
    <p>{cleaned ? "Processed sample from the selected source time. Return to marking to compare or refine the area." : "Colored areas are the removal mask. Preview removal to see the cleaned pixels. Your export applies the masks before the rest of the edit."}</p>
    {error && <ProblemNotice message={error} operation="Preview watermark removal" />}
  </div>;
}
