import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Check, FolderOpen, Link2, LoaderCircle, Pause, Play, Upload, X } from "lucide-react";
import type { Health, VideoSource } from "../shared/types";
import type { ImportSession } from "../shared/imports";
import { importRequest, transferImport, uploadIdentity } from "./import-client";
import "./imports.css";

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
type Props = {
  health: Health | null;
  connected: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onImported: (sources: VideoSource[]) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
};

export default function ImportPanel(props: Props) {
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [localPaths, setLocalPaths] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const sessionsRef = useRef(sessions);
  const files = useRef(new Map<string, File>());
  const seen = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const callbacks = useRef(props);
  callbacks.current = props;
  const mounted = useRef(true);
  const transfer = useRef<{ id: string; controller: AbortController } | null>(null);
  const loopBusy = useRef(false);
  const resumeId = useRef<string | null>(null);
  const resumeInput = useRef<HTMLInputElement>(null);

  const update = useCallback((incoming: ImportSession[]) => {
    if (!mounted.current) return;
    // Ignore older polling offsets while a chunk response has already advanced us.
    const current = new Map(sessionsRef.current.map(session => [session.id, session]));
    for (const session of incoming) {
      if (removed.current.has(session.id)) continue;
      const previous = current.get(session.id);
      if (previous && ["completed", "failed"].includes(previous.status) && session.status !== previous.status) continue;
      if (previous?.status === "processing" && session.status === "uploading") continue;
      if (previous && previous.offset > session.offset && previous.status === "uploading" && session.status === "uploading") continue;
      current.set(session.id, session);
      if (session.status === "completed" && session.source && !seen.current.has(session.id)) {
        seen.current.add(session.id);
        files.current.delete(session.id);
        callbacks.current.onImported([session.source]);
      }
    }
    sessionsRef.current = [...current.values()];
    setSessions(sessionsRef.current);
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let polling = false;
    const controller = new AbortController();
    const picker = resumeInput.current;
    const cancelPicker = () => { resumeId.current = null; };
    picker?.addEventListener("cancel", cancelPicker);
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await importRequest<{ imports: ImportSession[] }>("/api/imports", { signal: controller.signal });
        if (!stopped) update(result.imports);
      } catch { /* Workspace connection status handles transient API outages. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      mounted.current = false;
      clearInterval(timer);
      controller.abort();
      picker?.removeEventListener("cancel", cancelPicker);
      transfer.current?.controller.abort();
      callbacks.current.onBusyChange(false);
    };
  }, [update]);

  const runQueue = async () => {
    if (loopBusy.current) return;
    loopBusy.current = true;
    try {
      while (mounted.current) {
        const next = sessionsRef.current.find(item => item.status === "uploading" && files.current.has(item.id));
        if (!next) break;
        const file = files.current.get(next.id)!;
        files.current.delete(next.id);
        const controller = new AbortController();
        transfer.current = { id: next.id, controller };
        setActive(next.id);
        callbacks.current.onBusyChange(true);
        try {
          update([await transferImport(file, next, controller.signal, item => update([item]))]);
        } catch (error) {
          if (!controller.signal.aborted && mounted.current)
            setErrors(current => ({ ...current, [next.id]: error instanceof Error ? error.message : "Upload interrupted. Select the file to resume." }));
        } finally {
          transfer.current = null;
          if (mounted.current) setActive(null);
        }
      }
    } finally {
      loopBusy.current = false;
      callbacks.current.onBusyChange(false);
    }
  };

  const selectFiles = async (selected: File[], requestedId?: string | null) => {
    if (!selected.length || choosing) return;
    const maximum = props.health?.maxLargeFileSize || 50 * 1024 ** 3;
    if (selected.length > (props.health?.maxFiles || 30)) {
      props.onError(`Choose up to ${props.health?.maxFiles || 30} videos at once.`);
      return;
    }
    setChoosing(true);
    try {
      for (const file of selected) {
        if (file.size > maximum) { props.onError(`${file.name} exceeds the ${size(maximum)} import limit.`); continue; }
        if (!/\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu.test(file.name)) { props.onError(`${file.name}: choose a supported video file.`); continue; }
        const identity = await uploadIdentity(file);
        const requested = requestedId ? sessionsRef.current.find(item => item.id === requestedId) : undefined;
        if (requestedId && !requested) throw new Error("This import is no longer available. Choose the video as a new import.");
        if (requested && (requested.size !== file.size || requested.identity !== identity || requested.name !== file.name || requested.lastModified !== file.lastModified))
          throw new Error("Choose the same unchanged video to resume this import.");
        let session = requested || sessionsRef.current.find(item => item.kind === "upload" && item.status === "uploading" &&
          item.name === file.name && item.size === file.size && item.lastModified === file.lastModified && item.identity === identity);
        session ||= await importRequest<ImportSession>("/api/imports", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, lastModified: file.lastModified, identity }) });
        if (!mounted.current) return;
        setErrors(current => { const next = { ...current }; delete next[session.id]; return next; });
        update([session]);
        files.current.set(session.id, file);
      }
      void runQueue();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "Unable to prepare this import.");
      void runQueue();
    } finally {
      resumeId.current = null;
      if (mounted.current) setChoosing(false);
    }
  };

  const remove = async (session: ImportSession) => {
    if (transfer.current?.id === session.id) transfer.current.controller.abort();
    files.current.delete(session.id);
    removed.current.add(session.id);
    try {
      await importRequest(`/api/imports/${session.id}`, { method: "DELETE" });
      sessionsRef.current = sessionsRef.current.filter(item => item.id !== session.id);
      setSessions(sessionsRef.current);
    } catch (error) {
      removed.current.delete(session.id);
      props.onError(error instanceof Error ? error.message : "Unable to cancel import.");
    }
  };

  const linkFiles = async () => {
    const paths = localPaths.split(/\r?\n/u).map(value => value.trim().replace(/^["']|["']$/gu, "")).filter(Boolean);
    if (!paths.length || localBusy) return;
    setLocalBusy(true);
    try {
      const result = await importRequest<{ imports: ImportSession[]; errors?: { name: string; error: string }[] }>("/api/imports/local", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }),
      });
      update(result.imports);
      result.errors?.forEach(item => props.onError(`${item.name}: ${item.error}`));
      if (!result.errors?.length) { setLocalPaths(""); setLocalOpen(false); }
    } catch (error) { props.onError(error instanceof Error ? error.message : "Unable to link these videos."); }
    finally { setLocalBusy(false); }
  };

  return <div className="import-panel">
    <input ref={props.inputRef} className="visually-hidden" type="file" multiple accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.mpeg,.mpg" aria-label="Upload videos"
      onChange={event => { void selectFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
    <input ref={resumeInput} className="visually-hidden" type="file" accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.mpeg,.mpg" aria-label="Resume video import"
      onChange={event => { const requested = resumeId.current; resumeId.current = null; void selectFiles(Array.from(event.target.files || []), requested); event.target.value = ""; }} />
    <button className={`dropzone ${dragging ? "dragging" : ""}`} disabled={!props.connected || choosing} onClick={() => props.inputRef.current?.click()}
      onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); void selectFiles(Array.from(event.dataTransfer.files)); }}>
      <span className="upload-icon">{choosing ? <LoaderCircle size={22} className="spin" /> : <Upload size={22} />}</span>
      <strong>{choosing ? "Preparing imports…" : "Drop your videos here"}</strong>
      <span>or <em>browse files</em></span>
      <small>Short clips or full recordings<br />Up to {size(props.health?.maxLargeFileSize || 50 * 1024 ** 3)} per video · resumable</small>
    </button>
    <button className="import-link-button" aria-expanded={localOpen} onClick={() => setLocalOpen(!localOpen)}><Link2 size={15} /> Link files on this computer</button>
    {localOpen && <div className="import-local">
      <label htmlFor="local-video-paths">Original video paths</label>
      <textarea id="local-video-paths" rows={3} placeholder="/Users/you/Movies/interview.mp4" value={localPaths} onChange={event => setLocalPaths(event.target.value)} />
      <p>One full path per line. On Mac, select files in Finder and press Option + Command + C.</p>
      <p>Uses your originals without copying them. Keep files in place until your exports finish.</p>
      <button className="secondary-button" disabled={!localPaths.trim() || localBusy || !props.connected} onClick={() => void linkFiles()}>
        {localBusy ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />} Link videos
      </button>
    </div>}
    {!!sessions.length && <div className="import-list" aria-label="Video imports">
      {sessions.map(session => {
        const complete = session.status === "completed";
        const uploading = session.status === "uploading";
        const working = active === session.id || session.status === "processing";
        const percent = complete ? 100 : uploading ? Math.floor(session.offset / session.size * 100) : session.progress;
        return <div className={`import-item ${complete ? "complete" : ""}`} key={session.id}>
          <div className="import-item-heading"><strong title={session.name}>{session.name}</strong>
            <button className="icon-button" aria-label={`${complete ? "Dismiss" : "Cancel"} import ${session.name}`} onClick={() => void remove(session)}><X size={14} /></button></div>
          <div className="import-item-status">{complete ? <Check size={13} /> : working ? <LoaderCircle size={13} className="spin" /> : null}
            <span>{complete ? "Ready in your workspace" : session.status === "failed" ? "Needs attention" : uploading ? active === session.id ? `Uploading · ${percent}%` : files.current.has(session.id) ? "Waiting to upload" : "Paused · select file to resume" : `${session.phase} · ${Math.round(percent)}%`}</span>
          </div>
          {!complete && <>
            <progress max={100} value={percent} aria-label={`${session.name} import progress`} />
            <small>{uploading ? `${size(session.offset)} of ${size(session.size)}` : size(session.size)}{session.kind === "local" ? " · linked original" : ""}</small>
            {(errors[session.id] || session.error) && <p className="import-error" role="alert">{errors[session.id] || session.error}</p>}
            {uploading && <button className="import-resume" onClick={() => {
              if (active === session.id) transfer.current?.controller.abort();
              else { resumeId.current = session.id; resumeInput.current?.click(); }
            }}>{active === session.id ? <Pause size={13} /> : <Play size={13} />}{active === session.id ? "Pause upload" : "Choose file to resume"}</button>}
          </>}
        </div>;
      })}
      {sessions.some(item => item.status === "uploading") && <p className="import-keep-open">Keep this browser tab open while uploading. Resume later by selecting the same file.</p>}
    </div>}
  </div>;
}
