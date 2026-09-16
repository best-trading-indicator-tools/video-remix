import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, Film, LoaderCircle, LockKeyhole, LockKeyholeOpen, RotateCcw, X } from "lucide-react";
import type { EditPlan, EditPlanChanges, EditPlanVisual, FocalPoint, QualityReport, RenderJob, RemixSettings } from "../shared/types";
import { DEFAULT_BROLL_COUNT, DEFAULT_BROLL_MAX_COVERAGE, MAX_BROLL_COUNT } from "../shared/types";
import { textLayoutIssues } from "../shared/framing";
import { focusPointAt, withTrackBounds } from "../shared/focus";
import { VISUAL_SOURCE_LABELS } from "../shared/visual-sources";
import PromptEditor, { savedEditExamples, type PromptProposal } from "./PromptEditor";
import EditorialReportSummary from "./EditorialReportSummary";
import "./edit-plan.css";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "The edit could not be saved. Please try again.");
  return body as T;
}
const differs = (first: unknown, second: unknown) => JSON.stringify(first) !== JSON.stringify(second);
const seconds = (value: number) => `${value.toFixed(2)}s`;
const CENTER: FocalPoint = { x: 0.5, y: 0.5 };
const DEFAULT_CAPTION_STYLE = { fontSize: 20, bottomPercent: 100 * 24 / 288 };

interface PromptDraftAnchor { plan: EditPlan; changes: EditPlanChanges }
interface PromptUndo { draft: EditPlan; refreshBroll: boolean; brollCount: number; brollMaxCoverage: number; anchor: PromptDraftAnchor | null; appliedIdentity: string }
const draftIdentity = (draft: EditPlan, refreshBroll: boolean, brollCount: number, brollMaxCoverage: number) => JSON.stringify({ draft, refreshBroll, brollCount, brollMaxCoverage });

/** Keep server-retimed media implicit, while preserving later manual corrections. */
function collectDraftChanges(plan: EditPlan, draft: EditPlan, refreshBroll: boolean, anchor: PromptDraftAnchor | null): EditPlanChanges {
  const changes: EditPlanChanges = { revision: plan.revision };
  if (refreshBroll) {
    changes.refreshBroll = true;
    if (anchor?.changes.preserveBroll) changes.preserveBroll = true;
  }
  if (plan.settings.hookText !== draft.settings.hookText) changes.hookText = draft.settings.hookText;
  if (differs(plan.cuts, draft.cuts)) changes.cuts = draft.cuts;
  for (const key of ["captions", "visuals"] as const) {
    if (anchor && !differs(anchor.plan[key], draft[key])) {
      if (anchor.changes[key] !== undefined) Object.assign(changes, { [key]: draft[key] });
    } else if (differs(plan[key], draft[key])) Object.assign(changes, { [key]: draft[key] });
  }
  const framing: NonNullable<EditPlanChanges["framing"]> = {};
  if (plan.settings.fit !== draft.settings.fit) framing.fit = draft.settings.fit;
  if (differs(plan.settings.focalPoint, draft.settings.focalPoint)) framing.focalPoint = draft.settings.focalPoint;
  if (differs(plan.settings.captionStyle, draft.settings.captionStyle)) framing.captionStyle = draft.settings.captionStyle;
  if (Object.keys(framing).length) changes.framing = framing;
  return changes;
}

function validateDraftChanges(plan: EditPlan, draft: EditPlan, changes: EditPlanChanges): void {
  if (changes.refreshBroll && changes.visuals !== undefined) throw new Error("Render or reset your shot changes before searching for new B-roll.");
  if (changes.cuts) {
    if (draft.cuts.some((cut) => !Number.isFinite(cut.start) || !Number.isFinite(cut.end) ||
      cut.start < 0 || cut.end - cut.start < 0.04 - 1e-9 || cut.end > plan.sourceDuration)) {
      throw new Error("Cut points must stay within the source and end after they start.");
    }
    if (plan.narration && Math.abs(draft.cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) / plan.settings.speed - plan.outputDuration) > 0.001) {
      throw new Error("Keep the total cut duration unchanged so the footage stays aligned with the saved narration.");
    }
  }
  if (changes.captions?.some((cue) => !cue.text.trim() || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
    cue.start < 0 || cue.end <= cue.start || cue.end > draft.outputDuration + 0.01)) {
    throw new Error("Each caption needs text and a valid time within the export.");
  }
  if (changes.visuals?.some((visual) => {
    if (!visual.enabled) return false;
    const media = draft.media.find((item) => item.id === visual.mediaId);
    return !media || ![visual.start, visual.end, visual.sourceStart].every(Number.isFinite) ||
      visual.start < 0 || visual.end <= visual.start || visual.end > draft.outputDuration + 0.01 ||
      visual.sourceStart < 0 || visual.sourceStart + visual.end - visual.start > media.duration + 0.01;
  })) throw new Error("Check each B-roll interval: it must fit both the export and the selected clip.");
}

export function QualityReportSummary({ report, compact = false }: { report?: QualityReport; compact?: boolean }) {
  if (!report) return null;
  return <details className={`quality-report ${report.status} ${compact ? "compact" : ""}`} open={!compact && report.status === "review"}>
    <summary>{report.status === "review" ? <AlertTriangle size={14} /> : <Check size={14} />}<strong>{report.status === "review" ? "Needs review" : "Checks passed"}</strong><span>{report.scope === "sampled" ? "Sampled video checks" : "Full video checks"}</span></summary>
    {report.issues.length ? <ul>{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{issue.start !== undefined && <span> ({seconds(issue.start)}{issue.end !== undefined ? `–${seconds(issue.end)}` : ""})</span>}</li>)}</ul> : <p>No issues were found in the checked footage.</p>}
    {report.scope === "sampled" && <p>Only sampled sections were checked. Review the full export before posting.</p>}
  </details>;
}

function FocalControls({ label, value, onChange, disabled = false }: { label: string; value: FocalPoint; onChange: (point: FocalPoint) => void; disabled?: boolean }) {
  return <fieldset className="edit-focal-controls" disabled={disabled}><legend>{label}</legend>
    {(["x", "y"] as const).map((axis) => <label className="edit-framing-slider" key={axis}>
      <span>{axis === "x" ? "Horizontal" : "Vertical"}<output>{Math.round(value[axis] * 100)}%</output></span>
      <input type="range" aria-label={`${label} ${axis === "x" ? "horizontal" : "vertical"}`} min={0} max={100} step={1} value={value[axis] * 100} onChange={(event) => onChange({ ...value, [axis]: event.target.valueAsNumber / 100 })} />
      <small><span>{axis === "x" ? "Left" : "Top"}</span><span>{axis === "x" ? "Right" : "Bottom"}</span></small>
    </label>)}
  </fieldset>;
}

function cropPosition(width: number, height: number, aspect: number, point: FocalPoint): string {
  const cropWidth = Math.min(width, height * aspect), cropHeight = Math.min(height, width / aspect);
  const percent = (dimension: number, retained: number, focal: number) => dimension - retained < 0.01 ? 50 :
    Math.min(1, Math.max(0, (dimension * focal - retained / 2) / (dimension - retained))) * 100;
  return `${percent(width, cropWidth, point.x)}% ${percent(height, cropHeight, point.y)}%`;
}

function FootagePreview({ url, label, start, end, aspect, focalPoint, fit = "crop", height = 350, onTime, onAspect, overlay }: {
  url: string; label: string; start: number; end: number; aspect?: number; focalPoint: FocalPoint;
  fit?: RemixSettings["fit"]; height?: number; onTime?: (time: number) => void; onAspect?: (aspect: number) => void; overlay?: (height: number) => ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const background = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ width: 16, height: 9 });
  const [frameHeight, setFrameHeight] = useState(height);
  const ratio = aspect || size.width / size.height;
  const position = cropPosition(size.width, size.height, ratio, focalPoint);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => { if (entries[0]) setFrameHeight(entries[0].contentRect.height); });
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const syncBackground = (time: number) => {
    const video = background.current;
    if (video && video.readyState > 0 && Math.abs(video.currentTime - time) > 0.1) video.currentTime = time;
  };
  return <div ref={frame} className="edit-framing-picture" style={{ aspectRatio: ratio, width: `min(100%, ${height * ratio}px)` }}>
    {fit === "blur" && <video ref={background} className="edit-framing-blur" src={`${url}#t=${start},${end}`} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} style={{ objectPosition: position }} onLoadedMetadata={(event) => { event.currentTarget.currentTime = start; }} />}
    <video className="edit-framing-video" src={`${url}#t=${start},${end}`} controls muted playsInline preload="metadata" aria-label={label}
      style={{ objectFit: fit === "crop" ? "cover" : "contain", objectPosition: fit === "crop" ? position : "center" }}
      onLoadedMetadata={(event) => { const video = event.currentTarget; setSize({ width: video.videoWidth, height: video.videoHeight }); if (video.videoHeight > 0) onAspect?.(aspect || video.videoWidth / video.videoHeight); video.currentTime = start; }}
      onSeeked={(event) => { const video = event.currentTarget; if (video.currentTime < start) video.currentTime = start; else if (video.currentTime > end) video.currentTime = end; syncBackground(video.currentTime); }}
      onPlay={(event) => { const video = event.currentTarget; if (video.currentTime < start || video.currentTime >= end - 0.02) video.currentTime = start; void background.current?.play().catch(() => {}); }}
      onPause={() => background.current?.pause()}
      onTimeUpdate={(event) => { const video = event.currentTarget; if (video.currentTime >= end) { video.pause(); if (video.currentTime > end + 0.1) video.currentTime = end; } syncBackground(video.currentTime); onTime?.(video.currentTime); }} />
    {overlay?.(frameHeight)}
  </div>;
}

export default function EditPlanEditor({ job, onClose, onCreated }: {
  job: RenderJob;
  onClose: () => void;
  onCreated: (job: RenderJob) => void;
}) {
  const savedBrollCount = job.auto?.brollCount ?? DEFAULT_BROLL_COUNT;
  const savedCoverage = job.auto?.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE;
  const [brollMaxCoverage, setBrollMaxCoverage] = useState(savedCoverage);
  const [coverageInput, setCoverageInput] = useState(String(savedCoverage));
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [draft, setDraft] = useState<EditPlan | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshBroll, setRefreshBroll] = useState(false);
  const [brollCount, setBrollCount] = useState(savedBrollCount);
  const [brollCountInput, setBrollCountInput] = useState(String(savedBrollCount));
  const [promptAnchor, setPromptAnchor] = useState<PromptDraftAnchor | null>(null);
  const [promptUndo, setPromptUndo] = useState<PromptUndo | null>(null);
  const [reload, setReload] = useState(0);
  const [previewMode, setPreviewMode] = useState<"export" | "framing">("export");
  const [previewCut, setPreviewCut] = useState(0);
  const [previewSourceTime, setPreviewSourceTime] = useState(0);
  const [platformGuide, setPlatformGuide] = useState<"off" | "instagram" | "tiktok">("off");
  const [guideBottom, setGuideBottom] = useState(22);
  const [guideRight, setGuideRight] = useState(16);
  const [knownOutputAspect, setKnownOutputAspect] = useState<number | undefined>();
  const dialog = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const savingRef = useRef(false);
  const correctionClock = useRef({ totalMs: 0, lastTick: 0, lastInteraction: 0, visible: false });
  const updateCorrectionClock = useRef<() => void>(() => {});
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    setBrollCount(savedBrollCount);
    setBrollCountInput(String(savedBrollCount));
  }, [job.id, savedBrollCount]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void request<EditPlan>(`/api/jobs/${job.id}/plan`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setPlan(value); setDraft(structuredClone(value)); setRefreshBroll(false); setPromptAnchor(null); setPromptUndo(null);
        }
      })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [job.id, reload]);

  useEffect(() => {
    if (!plan) return;
    const now = performance.now();
    correctionClock.current = { totalMs: 0, lastTick: now, lastInteraction: now, visible: document.visibilityState === "visible" };
    const accrue = () => {
      const clock = correctionClock.current;
      const timestamp = performance.now();
      if (clock.visible && !savingRef.current) {
        const activeUntil = Math.min(timestamp, clock.lastInteraction + 60_000);
        clock.totalMs = Math.min(86_400_000, clock.totalMs + Math.max(0, activeUntil - clock.lastTick));
      }
      clock.lastTick = timestamp;
    };
    updateCorrectionClock.current = accrue;
    const interact = (event: Event) => {
      if (!dialog.current?.contains(event.target as Node)) return;
      accrue();
      correctionClock.current.lastInteraction = performance.now();
    };
    const visibility = () => {
      accrue();
      correctionClock.current.visible = document.visibilityState === "visible";
      correctionClock.current.lastInteraction = performance.now();
    };
    const timer = window.setInterval(accrue, 1000);
    for (const name of ["pointerdown", "keydown", "input", "scroll"]) document.addEventListener(name, interact, true);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      for (const name of ["pointerdown", "keydown", "input", "scroll"]) document.removeEventListener(name, interact, true);
      document.removeEventListener("visibilitychange", visibility);
      updateCorrectionClock.current = () => {};
    };
  }, [plan]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), video[controls], [tabindex="0"]',
    ) || []).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);

  const cutTimingsChanged = !!plan && !!draft && differs((promptAnchor?.plan || plan).cuts.map(({ start, end }) => ({ start, end })), draft.cuts.map(({ start, end }) => ({ start, end })));
  const draftChanges = plan && draft ? collectDraftChanges(plan, draft, refreshBroll, promptAnchor) : null;
  const changed = !!draftChanges && Object.keys(draftChanges).length > 1;
  const draftKey = draft ? draftIdentity(draft, refreshBroll, brollCount, brollMaxCoverage) : "";
  const timelineCorrectionsChanged = draftChanges?.captions !== undefined || draftChanges?.visuals !== undefined;
  const explicitVisualChanges = draftChanges?.visuals !== undefined;
  const layoutIssues = draft ? textLayoutIssues(draft, knownOutputAspect) : [];
  const activeCut = draft?.cuts[previewCut] || draft?.cuts[0];
  const previewOutputTime = draft && activeCut ? (draft.cuts.slice(0, previewCut).reduce((sum, cut) => sum + cut.end - cut.start, 0) + Math.max(0, Math.min(previewSourceTime, activeCut.end) - activeCut.start)) / draft.settings.speed : 0;
  const activeCaption = draft?.captions.find((cue) => cue.start <= previewOutputTime && cue.end > previewOutputTime);
  const captionStyle = draft?.settings.captionStyle || DEFAULT_CAPTION_STYLE;
  const focalPoint = draft?.settings.focalPoint || CENTER;
  const commitBrollCount = () => {
    const parsed = Number(brollCountInput);
    const count = brollCountInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(MAX_BROLL_COUNT, Math.floor(parsed))) : brollCount;
    setBrollCount(count);
    setBrollCountInput(String(count));
  };
  const updateFraming = (patch: Partial<RemixSettings>) => {
    setDraft((value) => value && ({ ...value, settings: { ...value.settings, ...patch },
      cuts: patch.focalPoint ? value.cuts.map(({ focusTrack: _track, focalPoint: _point, ...cut }) => cut) : value.cuts }));
    setPreviewMode("framing");
  };
  const updateCutFraming = (index: number, point?: FocalPoint) => {
    setDraft((value) => value && ({ ...value, cuts: value.cuts.map((cut, cutIndex) => cutIndex === index ? { ...cut, focalPoint: point, focusTrack: undefined } : cut) }));
    setPreviewCut(index);
    setPreviewMode("framing");
  };
  const updateVisual = (id: string, changes: Partial<EditPlanVisual>) => setDraft((value) => value && ({
    ...value, visuals: value.visuals.map((visual) => visual.id === id ? { ...visual, ...changes } : visual),
  }));

  const suggestEdit = async (prompt: string, signal: AbortSignal): Promise<PromptProposal> => {
    if (!plan || !draft || savingRef.current) throw new Error("Wait for the current edit to finish loading.");
    if (!form.current?.reportValidity()) throw new Error("Correct the highlighted field before asking for an edit.");
    const changes = collectDraftChanges(plan, draft, refreshBroll, promptAnchor);
    if (refreshBroll) { changes.brollCount = brollCount; changes.brollMaxCoverage = brollMaxCoverage; }
    validateDraftChanges(plan, draft, changes);
    return request<PromptProposal>(`/api/jobs/${job.id}/edit-prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ revision: plan.revision, prompt, draft: changes }),
    });
  };

  const applyPrompt = (proposal: PromptProposal) => {
    if (!plan || !draft || savingRef.current || proposal.revision !== plan.revision) return;
    const next = structuredClone(proposal.plan);
    next.revision = plan.revision;
    const nextRefresh = !!proposal.changes.refreshBroll;
    setPromptUndo({ draft: structuredClone(draft), refreshBroll, brollCount, brollMaxCoverage, anchor: promptAnchor, appliedIdentity: draftIdentity(next, nextRefresh, proposal.changes.brollCount ?? brollCount, proposal.changes.brollMaxCoverage ?? brollMaxCoverage) });
    setPromptAnchor({ plan: structuredClone(next), changes: structuredClone(proposal.changes) });
    setDraft(next);
    setRefreshBroll(nextRefresh);
    if (proposal.changes.brollCount !== undefined) { setBrollCount(proposal.changes.brollCount); setBrollCountInput(String(proposal.changes.brollCount)); }
    if (proposal.changes.brollMaxCoverage !== undefined) { setBrollMaxCoverage(proposal.changes.brollMaxCoverage); setCoverageInput(String(proposal.changes.brollMaxCoverage)); }
    setPreviewCut(0);
    setPreviewSourceTime(next.cuts[0]?.start || 0);
    setPreviewMode("framing");
    setError("");
  };

  const submit = async (searchAgain = refreshBroll) => {
    if (!plan || !draft || (!changed && !searchAgain) || savingRef.current) return;
    setError("");
    const changes = collectDraftChanges(plan, draft, searchAgain, promptAnchor);
    if (searchAgain) { changes.brollCount = brollCount; changes.brollMaxCoverage = brollMaxCoverage; }
    try { validateDraftChanges(plan, draft, changes); }
    catch (reason) { setError((reason as Error).message); return; }
    updateCorrectionClock.current();
    changes.correctionSeconds = Math.min(86_400, Math.round(correctionClock.current.totalMs / 1000));
    savingRef.current = true;
    setSaving(true);
    try {
      const created = await request<RenderJob>(`/api/jobs/${job.id}/revisions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
      });
      onCreated(created);
    } catch (reason) { setError((reason as Error).message); }
    finally { savingRef.current = false; setSaving(false); }
  };

  return <div className="modal-backdrop edit-plan-backdrop" onClick={() => { if (!savingRef.current) onClose(); }}>
    <section ref={dialog} className="edit-plan-modal" role="dialog" aria-modal="true" aria-labelledby="edit-plan-title" onClick={(event) => event.stopPropagation()}>
      <header className="edit-plan-heading">
        <div><span className="eyebrow">REFINE YOUR FINISHED CUT{plan ? ` · REVISION ${plan.revision}` : ""}</span>
          <h2 id="edit-plan-title">Edit this result</h2><p>{job.summary?.title || job.sourceName}</p></div>
        <button type="button" className="icon-button" aria-label="Close result editor" onClick={onClose} disabled={saving}><X size={20} /></button>
      </header>
      {loading ? <div className="edit-plan-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading your edit…</div> :
        plan && draft ? <form ref={form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="edit-plan-body">
            <aside className="edit-plan-playback" aria-label="Video preview and checks" tabIndex={0}>
              <div className="edit-preview-tabs" aria-label="Preview view">
                <button type="button" aria-pressed={previewMode === "export"} onClick={() => setPreviewMode("export")}>Current export</button>
                <button type="button" aria-pressed={previewMode === "framing"} onClick={() => setPreviewMode("framing")}>Draft framing</button>
              </div>
              {previewMode === "export" ? <video src={`/api/jobs/${job.id}/video`} controls playsInline preload="metadata" aria-label="Current exported video" onLoadedMetadata={(event) => { const video = event.currentTarget; if (video.videoHeight > 0) setKnownOutputAspect(video.videoWidth / video.videoHeight); }} /> : activeCut && <>
                <label className="edit-plan-field edit-preview-cut">Preview source cut
                  <select value={previewCut} onChange={(event) => { setPreviewCut(Number(event.target.value)); setPreviewSourceTime(draft.cuts[Number(event.target.value)]?.start || 0); }}>
                    {draft.cuts.map((cut, index) => <option key={index} value={index}>Cut {index + 1} · {seconds(cut.start)}–{seconds(cut.end)}</option>)}
                  </select>
                </label>
                <FootagePreview key={`${plan.sourceId}-${previewCut}-${activeCut.start}-${activeCut.end}`} url={`/api/sources/${plan.sourceId}/video`} label={`Framing preview for cut ${previewCut + 1}`} start={Number.isFinite(activeCut.start) ? activeCut.start : 0} end={Number.isFinite(activeCut.end) ? activeCut.end : plan.sourceDuration}
                  aspect={draft.settings.aspect === "original" ? undefined : Number(draft.settings.aspect.split(":")[0]) / Number(draft.settings.aspect.split(":")[1])}
                  focalPoint={focusPointAt(activeCut.focusTrack, previewSourceTime, activeCut.focalPoint || focalPoint)} fit={draft.settings.fit} onTime={setPreviewSourceTime} onAspect={setKnownOutputAspect} overlay={(height) => <>
                    {draft.settings.hookText && previewOutputTime < draft.settings.hookDuration && <div className="edit-framing-hook" style={{ fontSize: `${height * Math.min(1, draft.settings.aspect === "original" ? 1 : Number(draft.settings.aspect.split(":")[0]) / Number(draft.settings.aspect.split(":")[1])) * 0.054}px` }}>{draft.settings.hookText}</div>}
                    {(draft.settings.callouts || []).filter((callout) => callout.start <= previewOutputTime && callout.end > previewOutputTime).map((callout, index) => <div className="edit-framing-callout" key={index} style={{ fontSize: `${height * 0.026}px` }}>{callout.text}</div>)}
                    {!!draft.captions.length && <div className="edit-framing-caption" style={{ bottom: `${captionStyle.bottomPercent}%`, fontSize: `${captionStyle.fontSize / 288 * height}px` }}>{activeCaption?.text || draft.captions[0]?.text}</div>}
                    {platformGuide !== "off" && <div className={`edit-platform-guide ${platformGuide}`} aria-hidden="true"><span className="guide-top">App header</span><span className="guide-right" style={{ width: `${guideRight}%`, bottom: `${guideBottom}%` }}>Actions</span><span className="guide-bottom" style={{ height: `${guideBottom}%` }}>Post text &amp; navigation</span></div>}
                  </>} />
                <label className="edit-plan-field edit-guide-field">Platform interface guide
                  <select value={platformGuide} onChange={(event) => { const guide = event.target.value as typeof platformGuide; setPlatformGuide(guide); setGuideBottom(guide === "tiktok" ? 24 : 22); setGuideRight(guide === "tiktok" ? 18 : 16); }}><option value="off">Off</option><option value="instagram">Instagram Reels</option><option value="tiktok">TikTok</option></select>
                </label>
                {platformGuide !== "off" && <div className="edit-guide-adjustments">
                  <label className="edit-framing-slider"><span>Bottom occupied area<output>{guideBottom}%</output></span><input type="range" aria-label="Guide bottom occupied area" min={5} max={40} step={1} value={guideBottom} onChange={(event) => setGuideBottom(event.target.valueAsNumber)} /></label>
                  <label className="edit-framing-slider"><span>Right occupied area<output>{guideRight}%</output></span><input type="range" aria-label="Guide right occupied area" min={5} max={30} step={1} value={guideRight} onChange={(event) => setGuideRight(event.target.valueAsNumber)} /></label>
                </div>}
                <p className="edit-plan-note">Approximate framing and text preview. Guides appear only here; app controls vary by device.{!!draft.captions.length && " A sample caption appears when no line is active."}</p>
              </>}
              <h3>{previewMode === "export" ? "Current export" : "Draft framing"}</h3><p>{previewMode === "export" ? "Review this version as you make corrections. Render to see your updated video." : "Adjust the crop and captions against the source footage. Render your revision to review the final result."}</p>
              <p>{seconds(previewMode === "framing" ? draft.outputDuration : plan.outputDuration)} finished cut{plan.narration ? " · Narration saved" : ""}</p>
              <QualityReportSummary report={job.qualityReport} />
              {changed ? <p className="editorial-coverage">Your draft changes have not received an editorial check. The saved export's findings are available in Exports and History. Render the revision to review its final result.</p>
                : <EditorialReportSummary report={job.editorialReport} repair={job.editorialRepair} />}
            </aside>
            <div className="edit-plan-fields" role="region" aria-label="Edit controls" tabIndex={0}>
              <PromptEditor contextKey={`${job.id}:${plan.revision}:${draftKey}`} disabled={saving} onSuggest={suggestEdit} onApply={applyPrompt}
                examples={savedEditExamples(draft)}
                applied={!!promptUndo} canUndo={!!promptUndo && promptUndo.appliedIdentity === draftKey} onUndo={() => {
                  if (!promptUndo || promptUndo.appliedIdentity !== draftKey) return;
                  setDraft(structuredClone(promptUndo.draft)); setRefreshBroll(promptUndo.refreshBroll); setBrollCount(promptUndo.brollCount); setBrollCountInput(String(promptUndo.brollCount)); setBrollMaxCoverage(promptUndo.brollMaxCoverage); setCoverageInput(String(promptUndo.brollMaxCoverage)); setPromptAnchor(promptUndo.anchor); setPromptUndo(null); setError("");
                  setPreviewCut(0); setPreviewSourceTime(promptUndo.draft.cuts[0]?.start || 0);
                }} />
              <details open className="edit-plan-section edit-framing-section">
                <summary>Framing &amp; caption placement</summary>
                <fieldset disabled={saving}>
                  <legend className="visually-hidden">Framing and caption style</legend>
                  <label className="edit-plan-field">Fit source footage
                    <select value={draft.settings.fit} onChange={(event) => updateFraming({ fit: event.target.value as RemixSettings["fit"] })}>
                      <option value="crop">Fill frame with a crop</option><option value="contain">Keep the whole video</option><option value="blur">Keep whole video with blurred background</option>
                    </select>
                  </label>
                  <p className="edit-plan-note">Choose the subject's position within the original picture. Crop positions move the visible area when the frame is filled; each cut can have its own position.</p>
                  <FocalControls label="Default crop position" value={focalPoint} onChange={(point) => updateFraming({ focalPoint: point })} disabled={draft.settings.fit === "contain"} />
                  <label className="edit-framing-slider"><span>Caption size<output>{captionStyle.fontSize}</output></span><input type="range" aria-label="Caption font size" min={12} max={40} step={1} value={captionStyle.fontSize} onChange={(event) => updateFraming({ captionStyle: { ...captionStyle, fontSize: event.target.valueAsNumber } })} /></label>
                  <label className="edit-framing-slider"><span>Caption distance from bottom<output>{captionStyle.bottomPercent.toFixed(1)}%</output></span><input type="range" aria-label="Caption distance from bottom" min={5} max={80} step={0.1} value={captionStyle.bottomPercent} onChange={(event) => updateFraming({ captionStyle: { ...captionStyle, bottomPercent: event.target.valueAsNumber } })} /></label>
                  {!!layoutIssues.length && <div className="edit-layout-issues" role="status"><strong><AlertTriangle size={14} />Text placement to review</strong><ul>{layoutIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></div>}
                </fieldset>
              </details>
              <fieldset disabled={saving}>
                <legend>Opening hook</legend>
                <label className="edit-plan-field">Text shown at the start
                  <textarea rows={2} maxLength={120} value={draft.settings.hookText} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, hookText: event.target.value } })} />
                </label>
              </fieldset>
              <details open className="edit-plan-section">
                <summary>Captions <span>{draft.captions.length}</span></summary>
                <p className="edit-plan-note">Removing added captions keeps any captions already baked into the original video.</p>
                {cutTimingsChanged && <p className="edit-plan-note">Render your new cut points first. Caption and B-roll timings will follow the revised cuts automatically.</p>}
                <fieldset disabled={saving || cutTimingsChanged}>
                  <legend className="visually-hidden">Caption corrections</legend>
                  {!!draft.captions.length && <button type="button" className="secondary-button edit-plan-remove-all-captions" onClick={() => {
                    setDraft({ ...draft, captions: [] }); setPreviewMode("framing"); setError("");
                  }}><X size={14} />Remove added captions</button>}
                  {!draft.captions.length && <p className="edit-plan-empty">This draft has no added captions.</p>}
                  {draft.captions.map((cue, index) => <div className="edit-plan-caption" key={cue.id}>
                    <label className="edit-plan-field">Caption {index + 1}
                      <textarea rows={2} required maxLength={500} value={cue.text} onChange={(event) => setDraft({ ...draft, captions: draft.captions.map((item) => item.id === cue.id ? { ...item, text: event.target.value } : item) })} />
                    </label>
                    <div className="edit-plan-times">
                      {(["start", "end"] as const).map((edge) => <label className="edit-plan-field" key={edge}>{edge === "start" ? "Start" : "End"} (s)
                        <input aria-label={`Caption ${index + 1} ${edge} in seconds`} type="number" required min={0} max={draft.outputDuration} step="any" value={Number.isFinite(cue[edge]) ? cue[edge] : ""} onChange={(event) => setDraft({ ...draft, captions: draft.captions.map((item) => item.id === cue.id ? { ...item, [edge]: event.target.valueAsNumber } : item) })} />
                      </label>)}
                    </div>
                    <button className="secondary-button edit-plan-remove-caption" type="button" aria-label={`Remove caption ${index + 1}`} onClick={() => setDraft({ ...draft, captions: draft.captions.filter((item) => item.id !== cue.id) })}><X size={12} />Remove caption</button>
                  </div>)}
                  <button type="button" className="secondary-button edit-plan-add-caption" onClick={() => {
                    let start = 0, end = draft.outputDuration;
                    for (const cue of [...draft.captions].sort((first, second) => first.start - second.start)) {
                      if (cue.start - start >= 0.1) { end = cue.start; break; }
                      start = Math.max(start, Number.isFinite(cue.end) ? cue.end : 0);
                    }
                    if (end - start < 0.1) { setError("Adjust or remove an existing caption to make room for another one."); return; }
                    setError("");
                    setDraft({ ...draft, captions: [...draft.captions, { id: crypto.randomUUID(), start, end: Math.min(end, start + 2), text: "" }].sort((first, second) => first.start - second.start) });
                  }}>Add caption</button>
                </fieldset>
              </details>
              <details className="edit-plan-section">
                <summary>Cut points <span>{draft.cuts.length}</span></summary>
                <p className="edit-plan-note">Times refer to your original source ({seconds(plan.sourceDuration)}). {plan.narration ? "Keep the total duration unchanged. Narration and caption timings stay fixed." : "Captions and B-roll are retimed when you change these boundaries."}</p>
                {timelineCorrectionsChanged && <p className="edit-plan-note">Render your caption or B-roll corrections before changing cut points.</p>}
                <fieldset disabled={saving}>
                  <legend className="visually-hidden">Source cut boundaries</legend>
                  {draft.cuts.map((cut, index) => <div className="edit-plan-cut" key={index}><div className="edit-cut-heading"><strong>Cut {index + 1}</strong><button className="secondary-button" type="button" onClick={() => { setPreviewCut(index); setPreviewMode("framing"); }}>Preview crop</button></div>
                    <fieldset disabled={timelineCorrectionsChanged}><legend className="visually-hidden">Cut {index + 1} timing</legend><div className="edit-plan-times">
                    {(["start", "end"] as const).map((edge) => <label className="edit-plan-field" key={edge}>{edge === "start" ? "Start" : "End"} (s)
                      <input aria-label={`Cut ${index + 1} ${edge} in seconds`} type="number" required min={0} max={plan.sourceDuration} step="any" value={Number.isFinite(cut[edge]) ? cut[edge] : ""} onChange={(event) => setDraft({ ...draft, cuts: draft.cuts.map((item, itemIndex) => itemIndex === index ? withTrackBounds({ ...item, [edge]: event.target.valueAsNumber }) : item) })} />
                    </label>)}
                    </div></fieldset>
                    <label className="edit-plan-check edit-custom-crop"><input type="checkbox" checked={!!cut.focalPoint} onChange={(event) => updateCutFraming(index, event.target.checked ? { ...focalPoint } : undefined)} />Custom crop position for this cut</label>
                    <FocalControls label={`Cut ${index + 1} crop position`} value={cut.focalPoint || focalPoint} disabled={!cut.focalPoint || draft.settings.fit === "contain"} onChange={(point) => updateCutFraming(index, point)} />
                  </div>)}
                </fieldset>
              </details>
              <details open className="edit-plan-section">
                <summary>B-roll & supporting visuals <span>{draft.visuals.length}</span></summary>
                <p className="edit-plan-note">Shots stay fixed while you correct text. Unlock a shot to replace it or adjust its timing.</p>
                {<div className="edit-broll-refresh">
                  <div><strong>Try another B-roll search</strong><p>Search for new stock shots and render this video. Saved animations and uploaded B-roll stay in place. Your caption, cut and framing edits are included; narration stays saved.</p></div>
                  <div className="edit-broll-refresh-controls">
                    <label className="edit-plan-field">Total supporting shots
                      <input type="number" inputMode="numeric" min={1} max={MAX_BROLL_COUNT} step={1} required
                        disabled={saving || explicitVisualChanges} value={brollCountInput} aria-describedby="edit-broll-count-note"
                        onChange={(event) => {
                          setBrollCountInput(event.target.value);
                          const count = event.target.valueAsNumber;
                          if (Number.isInteger(count) && count >= 1 && count <= MAX_BROLL_COUNT) setBrollCount(count);
                        }}
                        onBlur={commitBrollCount}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
                    </label>
                    <label className="edit-plan-field">Maximum B-roll coverage (%)
                      <input type="number" min={0} max={100} step={1} required disabled={saving || explicitVisualChanges} value={coverageInput}
                        onChange={event => { setCoverageInput(event.target.value); const n = event.target.valueAsNumber; if (Number.isInteger(n) && n >= 0 && n <= 100) setBrollMaxCoverage(n); }}
                        onBlur={() => { const n = coverageInput.trim() ? Number(coverageInput) : brollMaxCoverage; const limit = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : brollMaxCoverage; setBrollMaxCoverage(limit); setCoverageInput(String(limit)); }} />
                    </label>
                    <button type="button" className="secondary-button" disabled={saving || explicitVisualChanges} onClick={(event) => {
                      if (event.currentTarget.form?.reportValidity()) void submit(true);
                    }}><RotateCcw size={14} />Find B-roll again &amp; render</button>
                  </div>
                  <p id="edit-broll-count-note">Request 1–{MAX_BROLL_COUNT} supporting shots in total, including saved animations and uploaded B-roll. Up to three search and placement passes fill the remaining places; the result reports any shortage. Stock, saved animations and uploaded shots together must fit within {brollMaxCoverage}% of the video.</p>
                  {explicitVisualChanges && <p className="edit-plan-note">Render or reset your shot changes first.</p>}
                </div>}
                <fieldset disabled={saving || cutTimingsChanged}>
                  <legend className="visually-hidden">Supporting visual corrections</legend>
                  {!draft.visuals.length && <p className="edit-plan-empty">This export has no supporting visual placements.</p>}
                  {draft.visuals.map((visual, index) => {
                    const media = plan.media.find((item) => item.id === visual.mediaId);
                    const length = Math.max(0, visual.end - visual.start);
                    const previewStart = Number.isFinite(visual.sourceStart) ? visual.sourceStart : 0;
                    const previewEnd = previewStart + length;
                    const [aspectWidth, aspectHeight] = plan.settings.aspect === "original" ? [knownOutputAspect || media?.selection?.targetAspect || 16 / 9, 1] : plan.settings.aspect.split(":").map(Number);
                    const previewAspect = aspectWidth! / aspectHeight!;
                    return <article className={`edit-plan-visual ${visual.enabled ? "" : "is-removed"}`} key={visual.id}>
                      <div className="edit-plan-visual-heading"><h3><Film size={15} /> Shot {index + 1}</h3>
                        <label className="edit-plan-check"><input type="checkbox" checked={visual.enabled} onChange={(event) => updateVisual(visual.id, { enabled: event.target.checked })} />Include shot</label>
                      </div>
                      {media?.url && <FootagePreview key={`${media.id}:${previewStart}:${previewEnd}`} url={media.url} label={`Preview shot ${index + 1}`} start={previewStart} end={previewEnd} aspect={previewAspect} focalPoint={visual.focalPoint || CENTER} height={230} />}
                      {media?.kind === "graphic" && media.visualSource && <p className="edit-plan-note">{VISUAL_SOURCE_LABELS[media.visualSource]} · Animated card</p>}
                      <button type="button" className="secondary-button edit-plan-lock" disabled={!visual.enabled} aria-pressed={visual.locked} onClick={() => updateVisual(visual.id, { locked: !visual.locked })}>
                        {visual.locked ? <LockKeyhole size={14} /> : <LockKeyholeOpen size={14} />}{visual.locked ? "Unlock shot to edit" : "Lock this shot"}
                      </button>
                      <fieldset disabled={visual.locked || !visual.enabled}>
                        <legend className="visually-hidden">Shot {index + 1} media and timing</legend>
                        <label className="edit-plan-field">Selected clip
                          <select aria-label={`Shot ${index + 1} selected clip`} value={visual.mediaId} onChange={(event) => {
                            const chosen = plan.media.find((item) => item.id === event.target.value);
                            if (chosen) updateVisual(visual.id, { mediaId: chosen.id, sourceStart: chosen.selection?.sourceStart || 0, focalPoint: undefined, reason: chosen.selection?.reason || "Selected by you." });
                          }}>
                            {plan.media.filter((item) => item.kind !== "audio").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                          </select>
                        </label>
                        <div className="edit-plan-times edit-plan-three-times">
                          {(["start", "end", "sourceStart"] as const).map((edge) => <label className="edit-plan-field" key={edge}>{edge === "sourceStart" ? "Clip in-point" : edge === "start" ? "Export start" : "Export end"} (s)
                            <input aria-label={`Shot ${index + 1} ${edge} in seconds`} type="number" required min={0} max={edge === "sourceStart" ? media?.duration : draft.outputDuration} step="any" value={Number.isFinite(visual[edge]) ? visual[edge] : ""} onChange={(event) => updateVisual(visual.id, { [edge]: event.target.valueAsNumber })} />
                          </label>)}
                        </div>
                        <FocalControls label={`Shot ${index + 1} crop position`} value={visual.focalPoint || CENTER} onChange={(point) => updateVisual(visual.id, { focalPoint: point })} />
                      </fieldset>
                      <p className="edit-plan-note">{visual.reason || media?.selection?.reason || "Supporting footage selected for this part of the edit."}</p>
                      {media?.attribution && <p className="edit-plan-credit">Video by {media.attribution.creator} on <a href={media.attribution.url} target="_blank" rel="noreferrer">{media.attribution.provider}</a>{media.stock?.licenseUrl && <> · <a href={media.stock.licenseUrl} target="_blank" rel="noreferrer">License</a></>}</p>}
                    </article>;
                  })}
                </fieldset>
              </details>
            </div>
          </div>
          <footer className="edit-plan-footer">
            <div><p>A new revision keeps this export available.</p>{refreshBroll && <p className="edit-plan-pending-search">A stock search will request {brollCount} total supporting shots. {promptAnchor?.changes.preserveBroll ? "All existing shots will be kept." : "Saved animations and uploaded B-roll will be kept."}</p>}{error && <p className="edit-plan-error" role="alert">{error}</p>}</div>
            <div className="edit-plan-buttons"><button type="button" className="secondary-button" disabled={saving || (!changed && brollCount === savedBrollCount && brollMaxCoverage === savedCoverage)} onClick={() => { setDraft(structuredClone(plan)); setRefreshBroll(false); setBrollCount(savedBrollCount); setBrollCountInput(String(savedBrollCount)); setBrollMaxCoverage(savedCoverage); setCoverageInput(String(savedCoverage)); setPromptAnchor(null); setPromptUndo(null); setPreviewCut(0); setError(""); }}><RotateCcw size={14} />Reset changes</button>
              <button className="primary-button" type="submit" disabled={saving || !changed}>{saving ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{saving ? "Queuing revision…" : "Render this revision"}</button></div>
          </footer>
        </form> : <div className="edit-plan-loading"><p className="edit-plan-error" role="alert">{error || "This edit is unavailable."}</p><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>}
    </section>
  </div>;
}
