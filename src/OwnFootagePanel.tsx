import { useEffect, useRef, useState } from "react";
import { Film, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import type { OwnFootageAsset, OwnFootagePlacement } from "../shared/own-footage";
import "./own-footage.css";

export default function OwnFootagePanel({ value = [], onChange, onApplyAll, savedAssets = [], disabled = false }: {
  value?: OwnFootagePlacement[]; onChange: (value: OwnFootagePlacement[]) => void;
  onApplyAll?: (value: OwnFootagePlacement[]) => void; savedAssets?: OwnFootageAsset[]; disabled?: boolean;
}) {
  const [assets, setAssets] = useState<OwnFootageAsset[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef<XMLHttpRequest | null>(null);
  const load = async () => {
    try { const response = await fetch("/api/broll"); if (!response.ok) throw new Error("Could not load your clips. Try Refresh.");
      const body = await response.json(); setAssets(body.assets); }
    catch (reason) { setError((reason as Error).message); }
  };
  useEffect(() => { void load(); return () => uploadRequest.current?.abort(); }, []);
  const available = [...assets, ...savedAssets.filter(asset => !assets.some(item => item.id === asset.id))];
  const update = (id: string, patch: Partial<OwnFootagePlacement>) => onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  const upload = (file?: File) => {
    if (!file || uploadRequest.current) return;
    setError(""); setProgress(0);
    const xhr = new XMLHttpRequest(); uploadRequest.current = xhr;
    const data = new FormData(); data.append("videos", file);
    xhr.open("POST", "/api/broll");
    xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => { try {
      const body = JSON.parse(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300 || !body.assets?.length) throw new Error(body.error || "The footage could not be uploaded.");
      setAssets(current => [...current.filter(asset => !body.assets.some((added: OwnFootageAsset) => added.id === asset.id)), ...body.assets]);
      setSelected(body.assets[0].id);
    } catch (reason) { setError((reason as Error).message); } };
    xhr.onerror = () => setError("Upload interrupted. Please try again.");
    xhr.onloadend = () => { uploadRequest.current = null; setProgress(null); };
    xhr.send(data);
  };
  return <details className="own-footage"><summary><Film size={16} />Add my own footage <span>{value.length ? `${value.length} placement${value.length === 1 ? "" : "s"}` : "Optional"}</span></summary>
    <p className="own-footage-note">Add your whole clip at the end, or place a selected part at a precise time. “Insert” adds duration. “Cover” replaces the picture while the original speech continues.</p>
    <fieldset disabled={disabled || progress !== null}>
      <legend className="visually-hidden">Your footage placements</legend>
      <input ref={input} hidden type="file" accept="video/*,.mkv,.avi" onChange={event => { upload(event.target.files?.[0]); event.target.value = ""; }} />
      <div className="own-footage-toolbar"><button className="secondary-button" type="button" onClick={() => input.current?.click()}><Upload size={14} />Upload my video</button><button className="icon-button" type="button" aria-label="Refresh uploaded footage" onClick={() => void load()}><RefreshCw size={15} /></button></div>
      <div className="own-footage-add"><label>Uploaded clip<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a clip…</option>{available.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.duration.toFixed(1)}s</option>)}</select></label>
        <button type="button" className="secondary-button" disabled={!selected || value.length >= 20} onClick={() => { const asset = available.find(asset => asset.id === selected); if (!asset) return; onChange([...value, { id: crypto.randomUUID(), assetId: asset.id, mode: "insert", at: 0, start: 0, end: Math.min(3, asset.duration), audio: "clip", fit: "contain" }]); }}><Plus size={14} />Place clip</button></div>
      {value.map((item, index) => { const asset = available.find(asset => asset.id === item.assetId); return <article className="own-footage-placement" key={item.id}>
        <header><strong>{index + 1}. {asset?.name || "Saved clip unavailable"}</strong><button className="icon-button" type="button" aria-label={`Remove footage placement ${index + 1}`} onClick={() => onChange(value.filter(clip => clip.id !== item.id))}><Trash2 size={15} /></button></header>
        {asset && <video key={`${item.id}-${!!item.appendToEnd}`} src={asset.url} controls preload="metadata" playsInline onLoadedMetadata={event => { event.currentTarget.currentTime = item.appendToEnd ? 0 : item.start; }} onTimeUpdate={event => { const video = event.currentTarget; if (!video.paused && video.currentTime >= (item.appendToEnd ? asset.duration : item.end)) { video.pause(); video.currentTime = item.appendToEnd ? 0 : item.start; } }} />}
        <label className="own-footage-append"><input type="checkbox" checked={!!item.appendToEnd} onChange={event => update(item.id, event.target.checked
          ? { appendToEnd: true, mode: "insert", at: 0, start: 0, end: asset?.duration ?? item.end }
          : { appendToEnd: false })} />
          <span><strong>Add the whole clip at the end</strong><small>{item.appendToEnd
            ? `The full${asset ? ` ${asset.duration.toFixed(1)}-second` : ""} clip plays after the finished video. No timestamps needed.`
            : "Append automatically to each finished video, even if its length changes."}</small></span>
        </label>
        <div className="own-footage-fields">
          {!item.appendToEnd && <>
          <label>Placement mode<select value={item.mode} onChange={event => update(item.id, { mode: event.target.value as OwnFootagePlacement["mode"] })}><option value="insert">Insert · add duration</option><option value="cover">Cover · keep original speech</option></select></label>
          <label>At edit time (seconds)<input type="number" min={0} step={0.1} value={item.at} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) update(item.id, { at: event.target.valueAsNumber }); }} /></label>
          <label>Clip start (seconds)<input type="number" min={0} max={asset?.duration} step={0.1} value={item.start} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) update(item.id, { start: event.target.valueAsNumber }); }} /></label>
          <label>Clip end (seconds)<input type="number" min={0.1} max={asset?.duration} step={0.1} value={item.end} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) update(item.id, { end: event.target.valueAsNumber }); }} /></label>
          </>}
          {item.mode === "insert" && <label>Inserted audio<select value={item.audio} onChange={event => update(item.id, { audio: event.target.value as OwnFootagePlacement["audio"] })}><option value="clip">Use my clip’s audio</option><option value="mute">Silent insert</option></select></label>}
          <label>Framing<select value={item.fit} onChange={event => update(item.id, { fit: event.target.value as OwnFootagePlacement["fit"] })}><option value="contain">Keep the full shot</option><option value="crop">Fill the frame · center crop</option></select></label>
        </div>
        {!item.appendToEnd && (item.start >= item.end || (asset && item.end > asset.duration)) && <p className="own-footage-error" role="alert">Choose an end after the start and within this clip.</p>}
      </article>; })}
      {onApplyAll && value.length > 0 && <button type="button" className="secondary-button" onClick={() => onApplyAll(structuredClone(value))}>Use these placements for all videos</button>}
    </fieldset>
    {progress !== null && <div className="own-footage-upload" role="status"><span>{progress === 100 ? "Preparing your clip…" : `Uploading ${progress}%`}</span><button className="secondary-button" type="button" onClick={() => uploadRequest.current?.abort()}><X size={14} />Cancel upload</button></div>}
    {error && <p className="own-footage-error" role="alert">{error}</p>}
  </details>;
}
