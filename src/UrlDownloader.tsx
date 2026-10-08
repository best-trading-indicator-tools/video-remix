import { useEffect, useRef, useState } from "react";
import { Check, Download, Link2, LoaderCircle, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { Health } from "../shared/types";
import { DEFAULT_IMPORT_BATCH_SIZE, type ImportSession } from "../shared/imports";
import { parseSocialVideoLinks } from "../shared/social-imports";
import { formatFileSize, importRequest, importVideoLinks } from "./import-client";
import ProblemNotice from "./ProblemNotice";
import "./url-downloader.css";

export default function UrlDownloader({ health, connected, active }: { health: Health | null; connected: boolean; active: boolean }) {
  const [links, setLinks] = useState("");
  const [stripMetadata, setStripMetadata] = useState(true);
  const [items, setItems] = useState<ImportSession[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const version = useRef(0), submitting = useRef(false), requests = useRef(new Set<string>());
  const selectAll = useRef<HTMLInputElement>(null);
  const batch = parseSocialVideoLinks(links), maximum = health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE;
  const ready = items.filter(item => item.status === "completed" && item.download);
  const selectedReady = ready.filter(item => selected.includes(item.id));
  const zipItems = selectedReady.length ? selectedReady : ready.slice(0, 100);
  const working = items.filter(item => item.status === "processing").length;
  const failed = items.filter(item => item.status === "failed").length;
  const allSelected = ready.length > 0 && ready.slice(0, 100).every(item => selected.includes(item.id));
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedReady.length > 0 && !allSelected; }, [selectedReady.length, allSelected]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true; const started = version.current;
      try {
        const result = await importRequest<{ imports: ImportSession[] }>("/api/downloads", { signal: controller.signal });
        if (!controller.signal.aborted && started === version.current) {
          setItems(result.imports); setLoaded(true); setConnectionError("");
          setSelected(current => current.filter(id => result.imports.some(item => item.id === id && item.status === "completed" && item.download)));
        }
      } catch (error) { if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : "Could not refresh downloads."); }
      finally { polling = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [active]);

  const start = async () => {
    if (submitting.current || !batch.links.length || batch.links.length > maximum) return;
    submitting.current = true; setBusy(true); setError(""); setNotice(""); version.current++;
    try {
      const result = await importVideoLinks(batch.links, { stripMetadata });
      version.current++;
      setItems(current => [...result.imports, ...current.filter(item => !result.imports.some(added => added.id === item.id))]);
      const unresolved = [...batch.invalid.map(item => item.input), ...(result.errors ?? []).map(item => item.name)];
      setLinks(unresolved.join("\n"));
      setNotice(`${result.imports.length} video${result.imports.length === 1 ? "" : "s"} added. You can leave this page while downloads run.${unresolved.length ? " Links needing attention remain above." : ""}`);
      if (result.errors?.length) setError(result.errors.map(item => `${item.name}: ${item.error}`).join("\n"));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not add these links."); }
    finally { submitting.current = false; setBusy(false); }
  };
  const act = async (item: ImportSession, action: "retry" | "remove") => {
    if (requests.current.has(item.id)) return;
    requests.current.add(item.id); setPending([...requests.current]); setError(""); version.current++;
    try {
      if (action === "retry") {
        const updated = await importRequest<ImportSession>(`/api/imports/${item.id}/retry`, { method: "POST" });
        version.current++; setItems(current => current.map(entry => entry.id === item.id ? updated : entry));
      } else {
        await importRequest(`/api/imports/${item.id}`, { method: "DELETE" });
        version.current++; setItems(current => current.filter(entry => entry.id !== item.id));
        setSelected(current => current.filter(id => id !== item.id)); setRemoveId(null);
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Could not update this download."); }
    finally { requests.current.delete(item.id); setPending([...requests.current]); }
  };

  return <section className="url-downloader" aria-label="URL downloader">
    <section className="panel downloader-entry">
      <div className="downloader-title"><div><span className="eyebrow">EXTRA TOOL</span><h2>Paste links. Save videos.</h2></div><span className="downloader-free">Free · No AI credits</span></div>
      <p>Download from YouTube, YouTube Shorts, TikTok and Instagram. Paste up to {maximum} video links at once.</p>
      <form onSubmit={event => { event.preventDefault(); void start(); }}>
        <label htmlFor="download-video-links">Video links</label>
        <textarea id="download-video-links" rows={5} value={links} disabled={busy} spellCheck={false}
          placeholder={'https://www.youtube.com/shorts/…\nhttps://www.tiktok.com/@creator/video/…\nhttps://www.instagram.com/reel/…'}
          onChange={event => setLinks(event.target.value)} aria-describedby="download-link-help" />
        <p id="download-link-help" className="downloader-note">One link per line, or separate links with spaces or commas. Duplicate links in this batch are skipped.</p>
        {links.trim() && <div className="downloader-link-summary" role="status"><strong>{batch.links.length} valid {batch.links.length === 1 ? "link" : "links"}</strong>
          {batch.duplicates > 0 && <span>{batch.duplicates} duplicate{batch.duplicates === 1 ? "" : "s"} skipped</span>}
          {batch.invalid.length > 0 && <span>{batch.invalid.length} {batch.invalid.length === 1 ? "link needs" : "links need"} attention</span>}</div>}
        {batch.invalid.length > 0 && <ul className="downloader-invalid">{batch.invalid.slice(0, 5).map((item, index) => <li key={index}><strong>{item.input}</strong> — {item.error}</li>)}{batch.invalid.length > 5 && <li>And {batch.invalid.length - 5} more invalid links.</li>}</ul>}
        {batch.links.length > maximum && <p className="downloader-validation" role="alert">Use up to {maximum} links per batch.</p>}
        <div className="downloader-start"><label className="downloader-clean"><input type="checkbox" checked={stripMetadata} disabled={busy} onChange={event => setStripMetadata(event.target.checked)} />
          <span><strong>Strip metadata</strong><small>{stripMetadata ? "Remove source tags, chapters and software tags." : "Save the imported file with its original metadata."}</small></span></label>
          <button className="primary-button" disabled={busy || !connected || !health?.ok || !batch.links.length || batch.links.length > maximum} type="submit">
            {busy ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{busy ? "Adding links…" : batch.links.length > 1 ? `Get ${batch.links.length} videos` : "Get video"}</button></div>
      </form>
      <p className="downloader-note">Full videos with their original audio. Downloads stay on this page; your editing workspace and its importer remain separate.</p>
    </section>
    {notice && <p className="downloader-notice" role="status"><Check size={16} />{notice}</p>}
    {error && <ProblemNotice message={error} operation="Download videos" />}
    {connectionError && <ProblemNotice message={connectionError} operation="Refresh downloads" />}
    <section className="panel downloader-results" aria-label="Download queue">
      <div className="downloader-title"><div><h2>Your downloads</h2><p role="status">{ready.length} ready{working ? ` · ${working} in progress` : ""}{failed ? ` · ${failed} need attention` : ""}</p></div>
        {zipItems.length > 0 && <a className="primary-button" href={`/api/downloads/selected.zip?ids=${encodeURIComponent(zipItems.map(item => item.id).join(","))}`} download>
          <Download size={16} />{selectedReady.length ? `Download selected · ${zipItems.length}` : ready.length > 100 ? "Download first 100 ready" : `Download all ready · ${zipItems.length}`}<span className="zip-tag">ZIP</span></a>}</div>
      <p className="downloader-note">Files are available here for 48 hours. Save them individually or together as a ZIP.</p>
      {ready.length > 0 && <div className="downloader-selection"><label><input ref={selectAll} type="checkbox" checked={allSelected}
        onChange={event => setSelected(event.target.checked ? ready.slice(0, 100).map(item => item.id) : [])} />{ready.length > 100 ? "Select first 100 ready" : "Select all ready"}</label><span>{selectedReady.length} selected</span>
        {selectedReady.length > 0 && <button className="text-button" onClick={() => setSelected([])}>Clear selection</button>}</div>}
      {!items.length && <div className="downloader-empty"><Link2 size={28} /><h3>{loaded ? "Your links become downloads here" : "Loading downloads…"}</h3><p>Paste a video link above to get started. Each video has its own progress and retry button.</p></div>}
      <div className="downloader-list">{items.map(item => {
        const isReady = item.status === "completed" && item.download, isPending = pending.includes(item.id);
        return <article className={`downloader-card is-${item.status}`} key={item.id} aria-label={item.name}>
          <div className="downloader-card-main">
            <input type="checkbox" aria-label={`Select ${item.name}`} checked={!!isReady && selected.includes(item.id)} disabled={!isReady || (!selected.includes(item.id) && selectedReady.length >= 100)}
              onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
            {isReady ? <img className="downloader-thumbnail" src={item.download!.thumbnailUrl} alt="" loading="lazy" /> : <div className="downloader-thumbnail placeholder"><Link2 size={21} /></div>}
            <div className="downloader-details"><h3>{item.name}</h3>{item.remoteUrl && <a className="downloader-source-link" href={item.remoteUrl} target="_blank" rel="noreferrer">{item.remoteUrl}</a>}
              <div className="downloader-meta">{isReady ? <><span>{Math.floor(item.download!.duration / 60)}:{String(Math.floor(item.download!.duration % 60)).padStart(2, "0")}</span><span>{formatFileSize(item.download!.size)}</span><span>{item.download!.width} × {item.download!.height}</span></> : <span>{item.phase}</span>}
                <span>{item.stripMetadata !== false ? <><ShieldCheck size={13} />Metadata {isReady ? "stripped" : "cleanup on"}</> : "Original metadata"}</span></div>
              {item.status === "processing" && <progress max={100} value={item.progress} aria-label={`Download progress for ${item.name}`} />}
            </div>
            <div className="downloader-card-actions">
              {isReady && <a className="secondary-button" href={item.download!.url} download><Download size={15} />Download MP4</a>}
              {item.status === "failed" && <button className="secondary-button" disabled={isPending || !connected} onClick={() => void act(item, "retry")}><RotateCcw size={15} />Retry</button>}
              <button className="text-button" disabled={isPending} onClick={() => isReady ? setRemoveId(item.id) : void act(item, "remove")}>
                {isPending ? <LoaderCircle size={15} className="spin" /> : <X size={15} />}{item.status === "processing" ? "Cancel" : "Remove"}</button>
            </div>
          </div>
          {item.error && <ProblemNotice message={item.error} diagnostic={item.diagnostic} operation="Download video" entityId={item.id} />}
          {removeId === item.id && <div className="downloader-remove" role="alert"><span>Remove this saved download from the app? Copies you already downloaded stay on your computer.</span>
            <button className="secondary-button" disabled={isPending} onClick={() => void act(item, "remove")}>Remove download</button><button className="text-button" disabled={isPending} onClick={() => setRemoveId(null)}>Keep it</button></div>}
        </article>;
      })}</div>
    </section>
  </section>;
}
