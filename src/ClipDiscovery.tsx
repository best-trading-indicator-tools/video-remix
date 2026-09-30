import { apiFetch, responseError, streamError } from "./api-client";
import { reportProblem } from "./diagnostics-store";
import ProblemNotice from "./ProblemNotice";
import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Plus, Sparkles, X } from "lucide-react";
import type { VideoSource } from "../shared/types";
import type { ClipDiscoveryResult, ClipSuggestion, DiscoveryEvent } from "../shared/clip-discovery";
import { formatSourceClock } from "../shared/shorts";

export default function ClipDiscovery({ source, active, remaining, onKeep }: {
  source?: VideoSource; active: boolean; remaining: number; onKeep: (clips: ClipSuggestion[]) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(5);
  const [min, setMin] = useState(15), [max, setMax] = useState(60);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [progress, setProgress] = useState({ message: "", progress: 0 });
  const [result, setResult] = useState<ClipDiscoveryResult | null>(null);
  const [kept, setKept] = useState<string[]>([]), [dismissed, setDismissed] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { controller.current?.abort(); setBusy(false); setResult(null); setError(""); setKept([]); setDismissed([]); setPreviewId(null); }, [source?.id]);
  useEffect(() => { if (!active) { controller.current?.abort(); setBusy(false); setPreviewId(null); } return () => controller.current?.abort(); }, [active]);
  const valid = Number.isInteger(count) && count >= 1 && count <= 20 && Number.isInteger(min) && min >= 1 && Number.isInteger(max) && max >= min && max <= 86400;
  const run = async (more = false) => {
    if (!source || !valid || busy) return;
    const request = new AbortController(); controller.current = request; setBusy(true); setError(""); setPreviewId(null);
    setProgress({ message: "Preparing discovery…", progress: 0 });
    try {
      const response = await apiFetch("/api/shorts/discover", { method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify({ sourceId: source.id, prompt, count, minSeconds: min, maxSeconds: max,
          exclude: more ? result?.clips.map(({ start, end }) => ({ start, end })) || [] : [] }) });
      if (!response.ok) throw await responseError(response, "/api/shorts/discover", "POST");
      const reader = response.body?.getReader(); if (!reader) throw new Error("Streaming is unavailable. Please retry.");
      const decoder = new TextDecoder(); let pending = "", complete = false;
      const receive = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as DiscoveryEvent;
        if (event.type === "error") throw streamError(event, "/api/shorts/discover", response.headers.get("X-Request-ID"));
        if (event.type === "progress") setProgress(event);
        if (event.type === "result") { complete = true; setResult(event.result); setKept([]); setDismissed([]); }
      };
      while (true) {
        const part = await reader.read(); pending += decoder.decode(part.value, { stream: !part.done });
        const lines = pending.split("\n"); pending = lines.pop() || ""; lines.forEach(receive);
        if (part.done) { receive(pending); break; }
      }
      if (!complete) throw new Error("Discovery was interrupted. Retry to reuse completed sections.");
    } catch (error) { if (!request.signal.aborted) { reportProblem(error, { operation: "Find clips", entityId: source.id }); setError(error instanceof Error ? error.message : "Discovery failed."); } }
    finally { if (controller.current === request) { controller.current = null; setBusy(false); } }
  };
  const visible = result?.clips.filter(clip => !dismissed.includes(clip.id)) || [];
  const keep = (clips: ClipSuggestion[]) => { const next = clips.filter(clip => !kept.includes(clip.id)).slice(0, remaining); onKeep(next); setKept(current => [...current, ...next.map(clip => clip.id)]); };
  return <section className="shorts-discovery panel">
    <div className="panel-heading"><h2><Sparkles size={17} />Find my best clips</h2><span className="shorts-kicker">REVIEW BEFORE RENDERING</span></div>
    <div className="shorts-discovery-body">
      <p className="shorts-helper">Find complete ideas in this video. Keep your favorites as editable short drafts.</p>
      <label>What should we look for? <span className="shorts-helper">Optional</span><textarea rows={2} maxLength={1200} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Practical relationship advice. Keep the explanation, skip sponsors." /></label>
      <div className="shorts-discovery-controls">
        <label>Maximum clips<input type="number" min={1} max={20} step={1} value={Number.isNaN(count) ? "" : count} onChange={event => setCount(event.target.valueAsNumber)} /></label>
        <label>Minimum seconds<input type="number" min={1} step={1} value={Number.isNaN(min) ? "" : min} onChange={event => setMin(event.target.valueAsNumber)} /></label>
        <label>Maximum seconds<input type="number" min={1} step={1} value={Number.isNaN(max) ? "" : max} onChange={event => setMax(event.target.valueAsNumber)} /></label>
        <button className="primary-button" disabled={!source || !valid || busy} onClick={() => void run()}><Sparkles size={15} />Find clips</button>
      </div>
      <p className="shorts-helper">Speech recognition runs locally. Idea selection uses your configured DeepSeek account. Fewer clips may fit your brief.</p>
      {!valid && <p className="shorts-error">Choose 1–20 clips and whole-second lengths, with minimum no greater than maximum (up to 24 hours).</p>}
      {busy && <div className="shorts-discovery-progress" role="status"><LoaderCircle className="spin" size={16} /><span>{progress.message}</span><progress value={progress.progress} max={100} aria-label="Clip discovery progress" /><button className="secondary-button" onClick={() => { controller.current?.abort(); setBusy(false); }}>Cancel</button></div>}
      {error && <ProblemNotice message={error} operation="Find clips" />}
      {result && <>
        <div className="shorts-discovery-results-heading"><strong>{result.clips.length} suggested clips</strong><span>{result.fullCoverage ? "All speech sections reviewed" : "Partial review"} · {result.reviewedSections}/{result.totalSections} sections</span></div>
        {result.notes.map(note => result.fullCoverage ? <p key={note} className="shorts-helper">{note}</p>
          : <ProblemNotice key={note} severity="warning" operation="Find clips" message={note} entityId={source?.id} />)}
        <div className="shorts-suggestions">{visible.map(clip => <article className="shorts-suggestion" key={clip.id}>
          {previewId === clip.id && source ? <video key={clip.id} src={`${source.url}#t=${clip.start},${clip.end}`} controls autoPlay playsInline
            onLoadedMetadata={event => { event.currentTarget.currentTime = clip.start; }}
            onPlay={event => { if (event.currentTarget.currentTime < clip.start || event.currentTarget.currentTime >= clip.end) event.currentTarget.currentTime = clip.start; }}
            onTimeUpdate={event => { if (event.currentTarget.currentTime >= clip.end) event.currentTarget.pause(); }} />
            : <button className="shorts-suggestion-poster" onClick={() => setPreviewId(clip.id)} aria-label={`Preview ${clip.title}`}><img src={source?.thumbnailUrl} alt="" /><span>Play excerpt · {(clip.end - clip.start).toFixed(1)}s</span></button>}
          <div><h3>{clip.title}</h3><p>{clip.takeaway}</p><span className="shorts-helper">{formatSourceClock(clip.start)} → {formatSourceClock(clip.end)}</span>
            <details><summary>Speech &amp; surrounding context</summary>{clip.before && <p className="shorts-helper">Before: {clip.before}</p>}<p>{clip.text}</p>{clip.after && <p className="shorts-helper">After: {clip.after}</p>}</details>
            <div className="shorts-suggestion-actions"><button className="secondary-button" disabled={kept.includes(clip.id) || remaining < 1} onClick={() => keep([clip])}>{kept.includes(clip.id) ? <Check size={14} /> : <Plus size={14} />}{kept.includes(clip.id) ? "Added to drafts" : "Keep clip"}</button><button className="text-button" onClick={() => setDismissed(current => [...current, clip.id])}><X size={14} />Dismiss</button></div>
          </div>
        </article>)}</div>
        <div className="shorts-suggestion-actions"><button className="secondary-button" disabled={!remaining || !visible.some(clip => !kept.includes(clip.id))} onClick={() => keep(visible)}>Keep all visible</button><button className="text-button" disabled={busy || !source || !valid} onClick={() => void run(true)}>Find other moments</button></div>
      </>}
    </div>
  </section>;
}
