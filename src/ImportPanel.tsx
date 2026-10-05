import ProblemNotice from "./ProblemNotice";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, FolderOpen, Link2, LoaderCircle, Pause, Play, RotateCcw, Upload, X } from "lucide-react";
import type { Health, VideoSource } from "../shared/types";
import { DEFAULT_IMPORT_BATCH_SIZE, type ImportSession } from "../shared/imports";
import { parseSocialVideoLinks } from "../shared/social-imports";
import { checkImportFile, createUploadImport, formatFileSize as size, importRequest, importVideoLinks, preparationSummary, transferImport, uploadIdentity } from "./import-client";
import { reportProblem } from "./diagnostics-store";
import { ApiError } from "./api-client";
import type { Diagnostic } from "../shared/diagnostics";
import "./imports.css";

type Props = {
  health: Health | null;
  connected: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onImported: (sources: VideoSource[]) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string, diagnostic?: Diagnostic) => void;
};

export default function ImportPanel(props: Props) {
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [preparingFile, setPreparingFile] = useState<{ name: string; index: number; total: number; stage: "reading" | "queueing" } | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const [preparationNotice, setPreparationNotice] = useState("");
  const [preparationProblems, setPreparationProblems] = useState<{ name: string; diagnostic: Diagnostic }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [localPaths, setLocalPaths] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [videoLinks, setVideoLinks] = useState("");
  const [linksBusy, setLinksBusy] = useState(false);
  const [linksNotice, setLinksNotice] = useState("");
  const [retrying, setRetrying] = useState<string[]>([]);
  const retryRequests = useRef(new Set<string>());
  const linkBatch = parseSocialVideoLinks(videoLinks);
  const maxLinks = props.health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE;
  const tooManyLinks = linkBatch.links.length > maxLinks;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectionErrors, setSelectionErrors] = useState<string[]>([]);
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
  const importOptions = useRef<HTMLDetailsElement>(null);
  const pending = sessions.filter(session => session.status !== "completed");
  const completed = sessions.filter(session => session.status === "completed");
  const failedCount = pending.filter(session => session.status === "failed" || errors[session.id]).length;
  const pausedCount = pending.filter(session => session.status === "uploading" && active !== session.id && !files.current.has(session.id) && !errors[session.id]).length;
  const importingCount = pending.length - failedCount - pausedCount;

  const closeImportOptions = () => {
    if (!importOptions.current?.open) return;
    // A submit button can lose focus when it becomes disabled during the request.
    const hadFocus = importOptions.current.contains(document.activeElement) || document.activeElement === document.body;
    importOptions.current.open = false;
    if (hadFocus) {
      importOptions.current.querySelector("summary")?.focus({ preventScroll: true });
      // Wait for the new progress cards and collapsed form to finish laying out.
      requestAnimationFrame(() => importOptions.current?.closest(".import-panel")?.scrollIntoView({ block: "nearest" }));
    }
  };

  const update = useCallback((incoming: ImportSession[]) => {
    if (!mounted.current) return;
    // Ignore older polling offsets while a chunk response has already advanced us.
    const current = new Map(sessionsRef.current.map(session => [session.id, session]));
    for (const session of incoming) {
      if (removed.current.has(session.id)) continue;
      const previous = current.get(session.id);
      if (previous && (previous.updatedAt ?? 0) > (session.updatedAt ?? 0)) continue;
      if (previous?.status === "completed" && session.status !== "completed") continue;
      if (previous?.status === "failed" && session.status !== "failed" && (session.updatedAt ?? 0) <= (previous.updatedAt ?? 0)) continue;
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
      preparation.current?.abort();
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
    if (!selected.length || preparation.current) return;
    const maximum = props.health?.maxLargeFileSize || 50 * 1024 ** 3;
    if (selected.length > (props.health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE)) {
      props.onError(`Choose up to ${props.health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE} videos at once.`);
      return;
    }
    setChoosing(true);
    const controller = new AbortController();
    preparation.current = controller;
    setPreparationNotice(""); setPreparationProblems([]);
    setSelectionErrors([]);
    const failures: { name: string; diagnostic: Diagnostic }[] = [];
    try {
      for (const [index, file] of selected.entries()) {
        if (!mounted.current || controller.signal.aborted) break;
        setPreparingFile({ name: file.name, index: index + 1, total: selected.length, stage: "reading" });
        try {
          checkImportFile(file, maximum);
          const identity = await uploadIdentity(file, controller.signal);
          const requested = requestedId ? sessionsRef.current.find(item => item.id === requestedId) : undefined;
          if (requestedId && !requested) throw new Error("This import is no longer available. Choose the video as a new import.");
          if (requested && (requested.size !== file.size || requested.identity !== identity || requested.name !== file.name || requested.lastModified !== file.lastModified))
            throw new Error("Choose the same unchanged video to resume this import.");
          let session = requested || sessionsRef.current.find(item => item.kind === "upload" && item.status === "uploading" &&
            item.name === file.name && item.size === file.size && item.lastModified === file.lastModified && item.identity === identity);
          setPreparingFile({ name: file.name, index: index + 1, total: selected.length, stage: "queueing" });
          session ||= await createUploadImport(file, identity, controller.signal);
          controller.signal.throwIfAborted();
          if (!mounted.current) return;
          setErrors(current => { const next = { ...current }; delete next[session.id]; return next; });
          update([session]);
          closeImportOptions();
          files.current.set(session.id, file);
          void runQueue();
        } catch (error) {
          if (controller.signal.aborted || !mounted.current) break;
          const problem = { name: file.name, diagnostic: error instanceof ApiError ? error.diagnostic
            : reportProblem(error instanceof Error ? error : new Error("Unable to prepare this import."), { operation: "Prepare video import" }) };
          failures.push(problem);
          setPreparationProblems(current => [...current, problem]);
          if (error instanceof ApiError && ["FILE_READ_TIMEOUT", "IMPORT_QUEUE_TIMEOUT", "ENGINE_UNREACHABLE", "BROWSER_CRYPTO_UNAVAILABLE"].includes(error.diagnostic.code)) {
            if (index + 1 < selected.length) setPreparationNotice("Preparation stopped. Files already queued can continue; the remaining files have not been prepared. Fix the reported problem before selecting them again.");
            break;
          }
        }
      }
      if (failures.length && mounted.current) {
        // The toast's copied report must carry the file's own code, not a generic summary.
        const summary = preparationSummary(failures);
        props.onError(summary.message, summary);
      }
      void runQueue();
    } finally {
      resumeId.current = null;
      if (preparation.current === controller) preparation.current = null;
      if (mounted.current) {
        setChoosing(false); setPreparingFile(null);
        if (controller.signal.aborted) setPreparationNotice("Preparation stopped. Files already queued can continue. If a server request was pending, refresh the queue before selecting the video again.");
      }
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
    if (paths.length > (props.health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE)) {
      props.onError(`Link up to ${props.health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE} videos at once.`);
      return;
    }
    setLocalBusy(true);
    setSelectionErrors([]);
    try {
      const result = await importRequest<{ imports: ImportSession[]; errors?: { name: string; error: string }[] }>("/api/imports/local", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }),
      });
      update(result.imports);
      if (result.errors?.length) {
        setSelectionErrors(result.errors.map(item => `${item.name}: ${item.error}`));
        props.onError(`${result.errors.length} video${result.errors.length === 1 ? "" : "s"} could not be linked. See the import details.`);
      }
      if (!result.errors?.length) { setLocalPaths(""); setLocalOpen(false); closeImportOptions(); }
    } catch (error) { props.onError(error instanceof Error ? error.message : "Unable to link these videos."); }
    finally { setLocalBusy(false); }
  };

  const retryImport = async (session: ImportSession) => {
    if (retryRequests.current.has(session.id)) return;
    retryRequests.current.add(session.id);
    setRetrying(current => [...current, session.id]);
    setErrors(current => { const next = { ...current }; delete next[session.id]; return next; });
    try {
      const item = await importRequest<ImportSession>(`/api/imports/${session.id}/retry`, { method: "POST" });
      update([item]);
    } catch (error) {
      if (mounted.current) setErrors(current => ({ ...current, [session.id]: error instanceof Error ? error.message : "Could not retry this import." }));
    } finally {
      retryRequests.current.delete(session.id);
      if (mounted.current) setRetrying(current => current.filter(id => id !== session.id));
    }
  };

  async function importLinks() {
    const { links, invalid, duplicates } = linkBatch;
    if (!links.length || linksBusy || tooManyLinks) return;
    setLinksBusy(true); setSelectionErrors([]); setLinksNotice("");
    try {
      const result = await importVideoLinks(links);
      if (!mounted.current) return;
      update(result.imports);
      const rejected = result.errors || [];
      setSelectionErrors(rejected.map(item => `${item.name}: ${item.error}`));
      setVideoLinks([...invalid.map(item => item.input), ...links.filter(link => rejected.some(item => item.name === link.slice(0, 180)))].join("\n"));
      setLinksNotice(`${result.imports.length} video${result.imports.length === 1 ? "" : "s"} added to the import queue.${duplicates ? ` ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped.` : ""}`);
      if (result.imports.length && !rejected.length && !invalid.length) closeImportOptions();
    } catch (error) {
      if (mounted.current) setSelectionErrors([error instanceof Error ? error.message : "Could not import these video links."]);
    } finally { if (mounted.current) setLinksBusy(false); }
  }

  return <div className="import-panel">
    <input ref={props.inputRef} className="visually-hidden" type="file" multiple accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.mpeg,.mpg" aria-label="Upload videos"
      onChange={event => { void selectFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
    <input ref={resumeInput} className="visually-hidden" type="file" accept="video/*,.mkv,.avi,.mov,.mp4,.webm,.m4v,.mpeg,.mpg" aria-label="Resume video import"
      onChange={event => { const requested = resumeId.current; resumeId.current = null; void selectFiles(Array.from(event.target.files || []), requested); event.target.value = ""; }} />
    {choosing && preparingFile && <div className="import-preparation">
      <p role="status">{preparingFile.index} of {preparingFile.total} · {preparingFile.name}<br />{preparingFile.stage === "reading"
        ? "Checking a small file sample before upload. This step stops after 30 seconds if it cannot finish."
        : "Creating the import before uploading. This step stops after 30 seconds if the server does not respond."}</p>
      <button type="button" className="secondary-button" onClick={() => preparation.current?.abort()}><X size={14} />Stop preparing</button>
    </div>}
    {preparationNotice && <p className="import-preparation-notice" role="status">{preparationNotice}</p>}
    {preparationProblems.map((problem, index) => <div key={index} className="import-preparation-problem">
      <strong>{problem.name}</strong><ProblemNotice message={problem.diagnostic.message} diagnostic={problem.diagnostic} operation="Prepare video import" />
    </div>)}
    {!!selectionErrors.length && <details className="import-selection-errors" open>
      <summary>{selectionErrors.length} video{selectionErrors.length === 1 ? "" : "s"} {selectionErrors.length === 1 ? "needs" : "need"} attention</summary>
      <ul>{selectionErrors.map((message, index) => <li key={index}><ProblemNotice message={message} operation="Import videos" /></li>)}</ul>
      <p>Other videos continue importing. Correct these files or links, then try again.</p>
    </details>}
    {!!pending.length && <section className="import-activity" aria-label="Import activity">
      {!!pending.length && <div className="import-overview">
        <strong>Import activity</strong>
        <div className="import-counts" role="status">
          {importingCount > 0 && <span>{importingCount} importing</span>}
          {pausedCount > 0 && <span>{pausedCount} paused</span>}
          {failedCount > 0 && <span className="import-count-error">{failedCount} {failedCount === 1 ? "needs" : "need"} attention</span>}
          {completed.length > 0 && <span className="import-count-complete">{completed.length} completed</span>}
        </div>
      </div>}
      <div id="video-import-list" className="import-list" role="region" aria-label="Video imports" tabIndex={0}>
        {pending.map(session => {
          const complete = session.status === "completed";
          const uploading = session.status === "uploading";
          const working = active === session.id || session.status === "processing";
          const percent = complete ? 100 : uploading ? Math.floor(session.offset / session.size * 100) : session.progress;
          return <div className={`import-item ${complete ? "complete" : session.status === "failed" || errors[session.id] ? "failed" : ""}`} key={session.id}>
            <div className="import-item-heading"><strong title={session.name}>{session.name}</strong>
              <button className="icon-button" aria-label={`${complete ? "Dismiss" : "Cancel"} import ${session.name}`} onClick={() => void remove(session)}><X size={14} /></button></div>
            <div className="import-item-status">{complete ? <Check size={13} /> : working ? <LoaderCircle size={13} className="spin" /> : null}
              <span>{complete ? "Ready in your workspace" : session.status === "failed" ? "Needs attention" : uploading ? active === session.id ? `Uploading · ${percent}%` : files.current.has(session.id) ? "Waiting to upload" : "Paused · select file to resume" : `${session.phase} · ${Math.round(percent)}%`}</span>
            </div>
            {!complete && <>
              <progress max={100} value={percent} aria-label={`${session.name} import progress`} />
              <small>{uploading ? `${size(session.offset)} of ${size(session.size)}` : session.size ? size(session.size) : "Size available after download"}{session.kind === "local" ? " · linked original" : ""}</small>
              {(errors[session.id] || session.error) && <ProblemNotice message={errors[session.id] || session.error || "Import failed."} diagnostic={errors[session.id] ? undefined : session.diagnostic} operation="Import video" entityId={session.id} />}
              {session.kind === "remote" && session.status === "failed" && <button className="import-resume" disabled={!props.connected || retrying.includes(session.id)} onClick={() => void retryImport(session)}>
                {retrying.includes(session.id) ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}{retrying.includes(session.id) ? "Retrying…" : "Retry import"}
              </button>}
              {uploading && <button className="import-resume" onClick={() => {
                if (active === session.id) transfer.current?.controller.abort();
                else { resumeId.current = session.id; resumeInput.current?.click(); }
              }}>{active === session.id ? <Pause size={13} /> : <Play size={13} />}{active === session.id ? "Pause upload" : "Choose file to resume"}</button>}
            </>}
          </div>;
        })}
        {sessions.some(item => item.status === "uploading") && <p className="import-keep-open">Keep this browser tab open while uploading. Resume later by selecting the same file.</p>}
      </div>
    </section>}
    <details className="import-tools" ref={importOptions}>
      <summary onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); if (props.connected && !choosing) void selectFiles(Array.from(event.dataTransfer.files)); }}
        className={dragging ? "dragging" : undefined}><Upload size={15} /> Add videos <ChevronDown size={14} /></summary>
      <button className={`dropzone import-dropzone ${dragging ? "dragging" : ""}`} disabled={!props.connected || choosing} onClick={() => props.inputRef.current?.click()}
        onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); if (props.connected && !choosing) void selectFiles(Array.from(event.dataTransfer.files)); }}>
        <span className="upload-icon">{choosing ? <LoaderCircle size={18} className="spin" /> : <Upload size={18} />}</span>
        <strong>{choosing ? preparingFile?.stage === "queueing" ? "Queueing videos…" : "Reading videos…" : "Browse files"}</strong>
        <span>{choosing ? "Preparing your import" : "or drop videos here"}</span>
      </button>
      <p className="import-limits">Up to {props.health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE} videos · {size(props.health?.maxLargeFileSize || 50 * 1024 ** 3)} each</p>
      <div className="import-options">
        <div className="import-local import-social">
          <label htmlFor="social-video-links"><Link2 size={15} /> Import from a video URL</label>
          <p id="social-video-link-hint">Paste a YouTube video or Shorts URL instead of uploading a file. TikTok and Instagram links work too.</p>
          <textarea id="social-video-links" rows={5} autoCapitalize="none" spellCheck={false}
            aria-describedby="social-video-link-hint social-video-link-format social-video-link-count" placeholder={"https://www.youtube.com/watch?v=…\nhttps://www.youtube.com/shorts/…\nhttps://youtu.be/…"} value={videoLinks}
            disabled={linksBusy} onChange={event => { setVideoLinks(event.target.value); setLinksNotice(""); }} />
          <p id="social-video-link-format">One link or a batch: separate URLs with new lines, spaces or commas.</p>
          <p id="social-video-link-count" className={tooManyLinks ? "import-error" : "import-link-count"} role="status">
            {tooManyLinks ? `${linkBatch.links.length} videos selected. Import up to ${maxLinks} at once.`
              : `${linkBatch.links.length} video${linkBatch.links.length === 1 ? "" : "s"} ready to import · Up to ${maxLinks} per batch`}
            {linkBatch.duplicates > 0 && ` · ${linkBatch.duplicates} duplicate${linkBatch.duplicates === 1 ? "" : "s"} will be skipped`}
          </p>
          {!!linkBatch.invalid.length && <div className="import-link-errors">
            <p>{linkBatch.invalid.length} {linkBatch.invalid.length === 1 ? "entry needs" : "entries need"} correction. Valid links can still be imported.</p>
            <ul>{linkBatch.invalid.slice(0, 5).map((item, index) => <li key={index}><strong>{item.input}</strong><span>{item.error}</span></li>)}</ul>
            {linkBatch.invalid.length > 5 && <p>And {linkBatch.invalid.length - 5} more. Correct the list above.</p>}
          </div>}
          <button className="secondary-button" disabled={!linkBatch.links.length || tooManyLinks || linksBusy || !props.connected} onClick={() => void importLinks()}>
            {linksBusy ? <LoaderCircle size={14} className="spin" /> : <Link2 size={14} />} {linksBusy ? "Adding links…" : linkBatch.links.length ? `Import ${linkBatch.links.length} video${linkBatch.links.length === 1 ? "" : "s"}` : "Import videos"}
          </button>
          {linksNotice && <p role="status">{linksNotice}</p>}
          <p>Public videos download into your workspace. Follow their progress in Import activity.</p>
        </div>
        <button className="import-link-button" aria-expanded={localOpen} onClick={() => setLocalOpen(!localOpen)}><FolderOpen size={15} /> Link files on this computer</button>
        {localOpen && <div className="import-local">
          <label htmlFor="local-video-paths">Original video paths</label>
          <textarea id="local-video-paths" rows={3} placeholder="/Users/you/Movies/interview.mp4" value={localPaths} onChange={event => setLocalPaths(event.target.value)} />
          <p>One full path per line. On Mac, select files in Finder and press Option + Command + C. On Windows, right-click a file and choose Copy as path.</p>
          <p>Uses your originals without copying them. Keep files in place until your exports finish.</p>
          <button className="secondary-button" disabled={!localPaths.trim() || localBusy || !props.connected} onClick={() => void linkFiles()}>
            {localBusy ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />} Link videos
          </button>
        </div>}
      </div>
      {!!completed.length && <details className="import-history">
        <summary className="import-completed-toggle">{completed.length} completed import{completed.length === 1 ? "" : "s"}<ChevronDown size={13} /></summary>
        <div className="import-list" role="region" aria-label="Completed video imports" tabIndex={0}>
          {completed.map(session => <div className="import-item complete" key={session.id}>
            <div className="import-item-heading"><strong title={session.name}>{session.name}</strong>
              <button className="icon-button" aria-label={`Dismiss import ${session.name}`} onClick={() => void remove(session)}><X size={14} /></button></div>
            <div className="import-item-status"><Check size={13} /><span>Ready in your workspace</span></div>
          </div>)}
        </div>
      </details>}
    </details>
  </div>;
}
