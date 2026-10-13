import { useEffect, useRef, useState } from "react";
import { Check, Download, Image as ImageIcon, Images, Film, Link2, LoaderCircle, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { Health } from "../shared/types";
import { DEFAULT_IMPORT_BATCH_SIZE, type ImportSession } from "../shared/imports";
import { parseSocialVideoLinks } from "../shared/social-imports";
import { formatFileSize, importRequest, importVideoLinks } from "./import-client";
import ProblemNotice from "./ProblemNotice";
import "./url-downloader.css";

type DownloaderProps = { health: Health | null; connected: boolean; active: boolean };
export default function UrlDownloader(props: DownloaderProps) {
  const [kind, setKind] = useState<"media" | "carousel">("media");
  return <div className="url-downloader">
    <div className="downloader-modes" role="tablist" aria-label="Download type">
      <button id="download-media-tab" role="tab" aria-controls="download-media-panel" aria-selected={kind === "media"} tabIndex={kind === "media" ? 0 : -1}
        onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { setKind("carousel"); document.getElementById("download-carousel-tab")?.focus(); } }} onClick={() => setKind("media")}><Film size={17} />Videos / images</button>
      <button id="download-carousel-tab" role="tab" aria-controls="download-carousel-panel" aria-selected={kind === "carousel"} tabIndex={kind === "carousel" ? 0 : -1}
        onKeyDown={event => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { setKind("media"); document.getElementById("download-media-tab")?.focus(); } }} onClick={() => setKind("carousel")}><Images size={17} />Carousel images</button>
    </div>
    {(["media", "carousel"] as const).map(mode => <div key={mode} id={`download-${mode}-panel`} role="tabpanel" aria-labelledby={`download-${mode}-tab`} hidden={kind !== mode}>
      <DownloadPanel {...props} kind={mode} active={props.active && kind === mode} />
    </div>)}
  </div>;
}

function DownloadPanel({ health, connected, active, kind }: DownloaderProps & { kind: "media" | "carousel" }) {
  const carousel = kind === "carousel";
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
  const batch = parseSocialVideoLinks(links, kind), maximum = health?.maxFiles || DEFAULT_IMPORT_BATCH_SIZE;
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
          setItems(result.imports.filter(item => carousel ? item.downloadKind === "carousel" : item.downloadKind !== "carousel")); setLoaded(true); setConnectionError("");
          setSelected(current => current.filter(id => result.imports.some(item => item.id === id && item.status === "completed" && item.download)));
        }
      } catch (error) { if (!controller.signal.aborted) setConnectionError(error instanceof Error ? error.message : "Could not refresh downloads."); }
      finally { polling = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 1500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [active, carousel]);

  const start = async () => {
    if (submitting.current || !batch.links.length || batch.links.length > maximum) return;
    submitting.current = true; setBusy(true); setError(""); setNotice(""); version.current++;
    try {
      const result = await importVideoLinks(batch.links, { stripMetadata: carousel ? false : stripMetadata, kind });
      version.current++;
      setItems(current => [...result.imports, ...current.filter(item => !result.imports.some(added => added.id === item.id))]);
      const unresolved = [...batch.invalid.map(item => item.input), ...(result.errors ?? []).map(item => item.name)];
      setLinks(unresolved.join("\n"));
      setNotice(`${result.imports.length} ${carousel ? "carousel" : "download"}${result.imports.length === 1 ? "" : "s"} added.${unresolved.length ? " Links needing attention remain above." : ""}`);
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

  return <section className="url-downloader" aria-label={carousel ? "Carousel downloader" : "Video and image downloader"}>
    <section className="panel downloader-entry">
      <div className="downloader-title"><div><span className="eyebrow">EXTRA TOOL</span><h2>{carousel ? "Carousel images" : "Videos / images"}</h2></div><span className="downloader-free">Free · No AI credits</span></div>
      <p>{carousel ? "Instagram posts and TikTok photo slideshows. Original images, in slide order, as a ZIP." : "Videos from YouTube, TikTok and Instagram. Images from Instagram and TikTok, in their original format."}</p>
      <form onSubmit={event => { event.preventDefault(); void start(); }}>
        <label htmlFor={`download-${kind}-links`}>{carousel ? "Carousel links" : "Video or image links"}</label>
        <textarea id={`download-${kind}-links`} rows={5} value={links} disabled={busy} spellCheck={false}
          placeholder={carousel ? 'https://www.instagram.com/p/DeXDaIPFCju/\nhttps://www.tiktok.com/@chrissy_dogdiary/photo/7694716604277345544' : 'https://www.youtube.com/shorts/…\nhttps://www.instagram.com/p/…\nhttps://www.tiktok.com/@creator/photo/…'}
          onChange={event => setLinks(event.target.value)} aria-describedby={`download-${kind}-help`} />
        <p id={`download-${kind}-help`} className="downloader-note">{carousel ? `Up to ${maximum} posts per batch. Images only; video slides and audio are skipped.` : `Up to ${maximum} links per batch. One file per post; Instagram slide links keep the selected slide.`}</p>
        {links.trim() && <div className="downloader-link-summary" role="status"><strong>{batch.links.length} valid {batch.links.length === 1 ? "link" : "links"}</strong>
          {batch.duplicates > 0 && <span>{batch.duplicates} duplicate{batch.duplicates === 1 ? "" : "s"} skipped</span>}
          {batch.invalid.length > 0 && <span>{batch.invalid.length} {batch.invalid.length === 1 ? "link needs" : "links need"} attention</span>}</div>}
        {batch.invalid.length > 0 && <ul className="downloader-invalid">{batch.invalid.slice(0, 5).map((item, index) => <li key={index}><strong>{item.input}</strong> — {item.error}</li>)}{batch.invalid.length > 5 && <li>And {batch.invalid.length - 5} more invalid links.</li>}</ul>}
        {batch.links.length > maximum && <p className="downloader-validation" role="alert">Use up to {maximum} links per batch.</p>}
        <div className="downloader-start">{carousel ? <span className="downloader-note">Original image quality and format</span> : <label className="downloader-clean"><input type="checkbox" checked={stripMetadata} disabled={busy} onChange={event => setStripMetadata(event.target.checked)} />
          <span><strong>Strip video metadata</strong><small>{stripMetadata ? "Remove video tags and chapters. Images stay original." : "Original video metadata and image files."}</small></span></label>}
          <button className="primary-button" disabled={busy || !connected || !health?.ok || !batch.links.length || batch.links.length > maximum} type="submit">
            {busy ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}{busy ? "Adding links…" : carousel ? batch.links.length > 1 ? `Get ${batch.links.length} carousels` : "Get images" : batch.links.length > 1 ? `Get ${batch.links.length} files` : "Get file"}</button></div>
      </form>
    </section>
    {notice && <p className="downloader-notice" role="status"><Check size={16} />{notice}</p>}
    {error && <ProblemNotice message={error} operation="Download media" />}
    {connectionError && <ProblemNotice message={connectionError} operation="Refresh downloads" />}
    <section className="panel downloader-results" aria-label="Download queue">
      <div className="downloader-title"><div><h2>Your downloads</h2><p role="status">{ready.length} ready{working ? ` · ${working} in progress` : ""}{failed ? ` · ${failed} need attention` : ""}</p></div>
        {zipItems.length > 0 && <a className="primary-button" href={`/api/downloads/selected.zip?ids=${encodeURIComponent(zipItems.map(item => item.id).join(","))}`} download>
          <Download size={16} />{selectedReady.length ? `Download selected · ${zipItems.length}` : ready.length > 100 ? "Download first 100 ready" : `Download all ready · ${zipItems.length}`}<span className="zip-tag">ZIP</span></a>}</div>
      <p className="downloader-note">Files are available here for 48 hours. Save them individually or together as a ZIP.</p>
      {ready.length > 0 && <div className="downloader-selection"><label><input ref={selectAll} type="checkbox" checked={allSelected}
        onChange={event => setSelected(event.target.checked ? ready.slice(0, 100).map(item => item.id) : [])} />{ready.length > 100 ? "Select first 100 ready" : "Select all ready"}</label><span>{selectedReady.length} selected</span>
        {selectedReady.length > 0 && <button className="text-button" onClick={() => setSelected([])}>Clear selection</button>}</div>}
      {!items.length && <div className="downloader-empty">{carousel ? <Images size={28} /> : <Link2 size={28} />}<h3>{loaded ? carousel ? "No carousel downloads yet" : "No downloads yet" : "Loading downloads…"}</h3></div>}
      <div className="downloader-list">{items.map(item => {
        const isReady = item.status === "completed" && item.download, isPending = pending.includes(item.id), image = item.download?.mediaType === "image";
        return <article className={`downloader-card is-${item.status}`} key={item.id} aria-label={item.name}>
          <div className="downloader-card-main">
            <input type="checkbox" aria-label={`Select ${item.name}`} checked={!!isReady && selected.includes(item.id)} disabled={!isReady || (!selected.includes(item.id) && selectedReady.length >= 100)}
              onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />
            {isReady ? <img className="downloader-thumbnail" src={item.download!.thumbnailUrl} alt="" loading="lazy" /> : <div className="downloader-thumbnail placeholder"><Link2 size={21} /></div>}
            <div className="downloader-details"><h3>{item.name}</h3>{item.remoteUrl && <a className="downloader-source-link" href={item.remoteUrl} target="_blank" rel="noreferrer">{item.remoteUrl}</a>}
              <div className="downloader-meta">{isReady ? <>{carousel ? <span><Images size={13} />{item.download!.imageCount} images</span> : image ? <span><ImageIcon size={13} />{item.name.split(".").at(-1)?.toUpperCase()} image</span> : <><span>{Math.floor(item.download!.duration! / 60)}:{String(Math.floor(item.download!.duration! % 60)).padStart(2, "0")}</span><span>{item.download!.width} × {item.download!.height}</span></>}<span>{formatFileSize(item.download!.size)}</span></> : <span>{item.status === "processing" && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{item.phase}</span>}
                <span>{carousel ? "Original images" : image ? "Original image" : item.stripMetadata !== false ? <><ShieldCheck size={13} />{isReady ? "Metadata stripped" : "Video metadata cleanup on"}</> : "Original metadata"}</span></div>
              {item.status === "processing" && <progress max={100} value={item.progress > 0 ? item.progress : undefined} aria-label={`Download progress for ${item.name}`} />}
            </div>
            <div className="downloader-card-actions">
              {isReady && <a className="secondary-button" href={item.download!.url} download><Download size={15} />{carousel ? "Download ZIP" : image ? "Download image" : "Download MP4"}</a>}
              {item.status === "failed" && <button className="secondary-button" disabled={isPending || !connected} onClick={() => void act(item, "retry")}><RotateCcw size={15} />Retry</button>}
              <button className="text-button" disabled={isPending} onClick={() => isReady ? setRemoveId(item.id) : void act(item, "remove")}>
                {isPending ? <LoaderCircle size={15} className="spin" /> : <X size={15} />}{item.status === "processing" ? "Cancel" : "Remove"}</button>
            </div>
          </div>
          {item.error && <ProblemNotice message={item.error} diagnostic={item.diagnostic} operation="Download media" entityId={item.id} />}
          {removeId === item.id && <div className="downloader-remove" role="alert"><span>Remove this saved download from the app? Copies you already downloaded stay on your computer.</span>
            <button className="secondary-button" disabled={isPending} onClick={() => void act(item, "remove")}>Remove download</button><button className="text-button" disabled={isPending} onClick={() => setRemoveId(null)}>Keep it</button></div>}
        </article>;
      })}</div>
    </section>
  </section>;
}
