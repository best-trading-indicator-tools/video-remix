import UpscaleControl from "./UpscaleControl";
import SourceRecovery, { type SourceStatus } from "./SourceRecovery";
import { DraftWriter, draftKey as resultDraftKey, parseDraft, type SavedDraft, type DraftBackup, type ResultDraft } from "./result-drafts";
import { exportTitle } from "../shared/export-presentation";
import EditTimeline from "./EditTimeline";
import { outputTimeAt, storyClips, storyTiming } from "../shared/edit-timeline";
import TimelinePreview from "./TimelinePreview";
import { useEditHistory } from "./useEditHistory";
import { apiRequest as request } from "./api-client";
import ProblemNotice from "./ProblemNotice";
import { GRAPHIC_KIND_LABELS } from "../shared/graphic-scene";
import FinishedReviewSummary from "./FinishedReviewSummary";
import { reviewShotTarget, type ReviewShotTarget } from "../shared/review-actions";
import type { FinishedIssue } from "../shared/finished-review";
import OwnFootagePanel from "./OwnFootagePanel";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, Film, LoaderCircle, LockKeyhole, LockKeyholeOpen, RotateCcw, X } from "lucide-react";
import type { EditPlan, EditPlanChanges, EditPlanVisual, FocalPoint, QualityReport, RenderJob, RemixSettings } from "../shared/types";
import { DEFAULT_BROLL_COUNT, DEFAULT_BROLL_MAX_COVERAGE, MAX_BROLL_COUNT } from "../shared/types";
import { textLayoutIssues } from "../shared/framing";
import BlackBandsEditor, { BlackBandsOverlay, bandVideoStyle } from "./BlackBandsEditor";
import type { BlackBands } from "../shared/black-bands";
import { withTrackBounds } from "../shared/focus";
import { VISUAL_SOURCE_LABELS } from "../shared/visual-sources";
import PromptEditor, { savedEditExamples, type PromptProposal } from "./PromptEditor";
import EditorialReportSummary from "./EditorialReportSummary";
import CaptionStyleEditor from "./CaptionStyleEditor";
import "./edit-plan.css";


const differs = (first: unknown, second: unknown) => JSON.stringify(first) !== JSON.stringify(second);
const seconds = (value: number) => `${value.toFixed(2)}s`;
const CENTER: FocalPoint = { x: 0.5, y: 0.5 };

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
  if (differs(plan.settings.ownFootage, draft.settings.ownFootage)) changes.ownFootage = draft.settings.ownFootage || [];
  if (plan.settings.hookDuration !== draft.settings.hookDuration) changes.hookDuration = draft.settings.hookDuration;
  if (plan.settings.hookText !== draft.settings.hookText) changes.hookText = draft.settings.hookText;
  if (differs(plan.cuts, draft.cuts)) changes.cuts = draft.cuts;
  for (const key of ["captions", "visuals"] as const) {
    if (anchor && !differs(anchor.plan[key], draft[key])) {
      if (anchor.changes[key] !== undefined) Object.assign(changes, { [key]: draft[key] });
    } else if (differs(plan[key], draft[key])) Object.assign(changes, { [key]: draft[key] });
  }
  const framing: NonNullable<EditPlanChanges["framing"]> = {};
  if ((plan.settings.upscale ?? "off") !== (draft.settings.upscale ?? "off")) framing.upscale = draft.settings.upscale ?? "off";
  if (plan.settings.fit !== draft.settings.fit) framing.fit = draft.settings.fit;
  if (differs(plan.settings.focalPoint, draft.settings.focalPoint)) framing.focalPoint = draft.settings.focalPoint;
  if (differs(plan.settings.captionStyle, draft.settings.captionStyle)) framing.captionStyle = draft.settings.captionStyle;
  if (differs(plan.settings.blackBands, draft.settings.blackBands)) framing.blackBands = draft.settings.blackBands;
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
    <summary>{report.status === "review" ? <AlertTriangle size={14} /> : <Check size={14} />}<strong>{report.status === "review" ? "Technical review needed" : "Technical checks passed"}</strong><span>{report.scope === "sampled" ? "Sampled scan" : "Full timeline scan"}</span></summary>
    {report.issues.length ? <ul>{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}{issue.start !== undefined && <span> ({seconds(issue.start)}{issue.end !== undefined ? `–${seconds(issue.end)}` : ""})</span>}</li>)}</ul> : <p>No technical issues were found in the checked footage. This scan checks dimensions, duration, audio levels, black frames and freezes; picture meaning and caption wording are reviewed separately.</p>}
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

function FootagePreview({ url, label, start, end, aspect, focalPoint, fit = "crop", height = 350, onTime, onAspect, overlay, blackBands, seek, speed = 1 }: {
  seek?: { time: number; token: number }; speed?: number;
  url: string; label: string; start: number; end: number; aspect?: number; focalPoint: FocalPoint;
  fit?: RemixSettings["fit"]; height?: number; onTime?: (time: number) => void; onAspect?: (aspect: number) => void; overlay?: (height: number) => ReactNode; blackBands?: BlackBands;
}) {
  const player = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (seek && player.current?.readyState) { player.current.currentTime = seek.time; onTime?.(seek.time); } }, [seek?.token]);
  const frame = useRef<HTMLDivElement>(null);
  const background = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ width: 16, height: 9 });
  const [frameHeight, setFrameHeight] = useState(height);
  const ratio = aspect || size.width / size.height;
  const bands = blackBands?.enabled ? blackBands : undefined;
  fit = bands?.fit ?? fit;
  const position = cropPosition(size.width, size.height, ratio / (bands ? 1 - (bands.topPercent + bands.bottomPercent) / 100 : 1), focalPoint);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => { if (entries[0]) setFrameHeight(entries[0].contentRect.height); });
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const syncBackground = (time: number) => {
    const video = background.current;
    if (video && video.readyState > 0 && Math.abs(video.currentTime - time) > 0.1) video.currentTime = time;
  };
  return <div ref={frame} className="edit-framing-picture" style={{ aspectRatio: ratio, width: `min(100%, ${height * ratio}px)`, background: bands ? "black" : undefined }}>
    {fit === "blur" && <video ref={background} className="edit-framing-blur" src={`${url}#t=${start},${end}`} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} style={{ objectPosition: position }} onLoadedMetadata={(event) => { event.currentTarget.currentTime = start; }} />}
    <video ref={player} className="edit-framing-video" src={`${url}#t=${start},${end}`} controls muted playsInline preload="metadata" aria-label={label}
      style={{ objectFit: fit === "crop" ? "cover" : "contain", objectPosition: fit === "crop" ? position : "center", ...bandVideoStyle(bands) }}
      onLoadedMetadata={(event) => { const video = event.currentTarget; setSize({ width: video.videoWidth, height: video.videoHeight }); if (video.videoHeight > 0) onAspect?.(aspect || video.videoWidth / video.videoHeight); video.currentTime = seek?.time ?? start; video.playbackRate = speed; }}
      onSeeked={(event) => { const video = event.currentTarget; if (video.currentTime < start) video.currentTime = start; else if (video.currentTime > end) video.currentTime = end; syncBackground(video.currentTime); }}
      onPlay={(event) => { const video = event.currentTarget; if (video.currentTime < start || video.currentTime >= end - 0.02) video.currentTime = start; void background.current?.play().catch(() => {}); }}
      onPause={() => background.current?.pause()}
      onTimeUpdate={(event) => { const video = event.currentTarget; if (video.currentTime >= end) { video.pause(); if (video.currentTime > end + 0.1) video.currentTime = end; } syncBackground(video.currentTime); onTime?.(video.currentTime); }} />
    <BlackBandsOverlay value={bands} aspect={ratio} />
    {overlay?.(frameHeight)}
  </div>;
}

export default function EditPlanEditor({ job, onClose, onCreated, initialIssue, sourceFps, onImport, onRecovered }: {
  job: RenderJob;
  onImport: () => void;
  onRecovered: (job: RenderJob) => void;
  initialIssue?: FinishedIssue;
  sourceFps?: number;
  onClose: () => void;
  onCreated: (job: RenderJob) => void;
}) {
  const savedBrollCount = job.auto?.brollCount ?? DEFAULT_BROLL_COUNT;
  const savedCoverage = job.auto?.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE;
  const [brollMaxCoverage, setBrollMaxCoverage] = useState(savedCoverage);
  const [coverageInput, setCoverageInput] = useState(String(savedCoverage));
  const [sourceProblem, setSourceProblem] = useState<SourceStatus | null>(null);
  const [saveState, setSaveState] = useState({ message: 'No unsaved changes', failed: false });
  const writer = useRef<DraftWriter | null>(null);
  const [draftChoice, setDraftChoice] = useState<{ backup: ResultDraft | null; valid: boolean } | null>(null);
  const finished = useRef(false);
  const [plan, setPlan] = useState<EditPlan | null>(null);
  const [draft, setDraft] = useState<EditPlan | null>(null);
  const [timelineFootage, setTimelineFootage] = useState(job.footageAssets ?? []);
  const timelineJob = { ...job, footageAssets: timelineFootage };
  const rememberFootage = (assets: NonNullable<RenderJob['footageAssets']>) => setTimelineFootage(current => [...current.filter(item => !assets.some(asset => asset.id === item.id)), ...assets]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshBroll, setRefreshBroll] = useState(false);
  const [brollCount, setBrollCount] = useState(savedBrollCount);
  const [brollCountInput, setBrollCountInput] = useState(String(savedBrollCount));
  const [promptAnchor, setPromptAnchor] = useState<PromptDraftAnchor | null>(null);
  const [promptUndo, setPromptUndo] = useState<PromptUndo | null>(null);
  const [reload, setReload] = useState(0);
  const [previewMode, setPreviewMode] = useState<"export" | "framing">("framing");
  const [timelineBusy, setTimelineBusy] = useState(false);
  const timelineBusyRef = useRef(false);
  const [transportRate, setTransportRate] = useState(0);
  const [seekToken, setSeekToken] = useState(0);
  const [platformGuide, setPlatformGuide] = useState<"off" | "instagram" | "tiktok">("off");
  const [guideBottom, setGuideBottom] = useState(22);
  const [guideRight, setGuideRight] = useState(16);
  const [knownOutputAspect, setKnownOutputAspect] = useState<number | undefined>();
  const dialog = useRef<HTMLElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const savingRef = useRef(false);
  const exportVideo = useRef<HTMLVideoElement>(null);
  const playbackPane = useRef<HTMLElement>(null);
  const [previewHeight, setPreviewHeight] = useState(280);
  useEffect(() => {
    if (!playbackPane.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const stacked = window.innerWidth <= 940 || window.innerHeight <= 690;
      setPreviewHeight(stacked ? 300 : Math.max(120, Math.min(480, entry.contentRect.height - 116)));
    });
    observer.observe(playbackPane.current);
    return () => observer.disconnect();
  }, [loading, previewMode]);
  const [reviewTime, setReviewTime] = useState(initialIssue?.start ?? 0);
  const [highlightedShot, setHighlightedShot] = useState<ReviewShotTarget>();
  const [reviewNotice, setReviewNotice] = useState("");
  const correctionClock = useRef({ totalMs: 0, lastTick: 0, lastInteraction: 0, visible: false });
  const updateCorrectionClock = useRef<() => void>(() => {});
  const closeRef = useRef(onClose);
  const closeEditor = () => {
    if (writer.current && !writer.current.localSafe) { void writer.current.flush(); setError('Your draft is not saved yet. Retry saving before closing.'); return; }
    void writer.current?.flush(); onClose();
  };
  closeRef.current = closeEditor;
  savingRef.current = saving;

  useEffect(() => {
    setBrollCount(savedBrollCount);
    setBrollCountInput(String(savedBrollCount));
  }, [job.id, savedBrollCount]);

  const footageIds = draft?.settings.ownFootage?.map(item => item.assetId).join(',');
  useEffect(() => {
    const controller = new AbortController();
    void request<{ assets: NonNullable<RenderJob['footageAssets']> }>('/api/broll', {signal:controller.signal})
      .then(({assets}) => { if (!controller.signal.aborted) rememberFootage(assets.filter(asset => !job.footageAssets?.some(saved => saved.id === asset.id))); }).catch(() => {});
    return () => controller.abort();
  }, [footageIds, job.id]);

  const restoreDraft = (restored: ResultDraft | null, original: EditPlan) => {
    setDraft(restored?.draft ?? structuredClone(original)); setRefreshBroll(restored?.refreshBroll ?? false);
    setPromptAnchor(restored?.promptAnchor ?? null); setPromptUndo(null);
    setBrollCount(restored?.brollCount ?? savedBrollCount); setBrollCountInput(String(restored?.brollCount ?? savedBrollCount));
    setBrollMaxCoverage(restored?.brollMaxCoverage ?? savedCoverage); setCoverageInput(String(restored?.brollMaxCoverage ?? savedCoverage));
    setReviewTime(restored?.reviewTime ?? 0);
  };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setSourceProblem(null);
    void (async () => {
      const status = await request<SourceStatus>(`/api/jobs/${job.id}/source-status`, { signal: controller.signal });
      if (!status.available) { if (!controller.signal.aborted) setSourceProblem(status); return; }
      const [value, saved] = await Promise.all([
        request<EditPlan>(`/api/jobs/${job.id}/plan`, { signal: controller.signal }),
        request<{ draft: SavedDraft | null }>(`/api/jobs/${job.id}/draft`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      let backup: DraftBackup | null = null;
      try { backup = JSON.parse(localStorage.getItem(resultDraftKey(job.id)) || 'null'); } catch { /* Server copy remains usable. */ }
      const backupValue = backup?.content ? parseDraft(backup.content, value) : null;
      const validBackup = !!backup && backup.revision === value.revision && (backup.content === null || !!backupValue);
      const conflict = !!backup && (!validBackup || (backup.token !== (saved.draft?.token ?? null) && backup.content !== saved.draft?.content));
      setDraftChoice(conflict ? { backup: backupValue, valid: validBackup } : null);
      const candidate = !conflict && backup ? backup : saved.draft;
      const restored = candidate?.content && candidate.revision === value.revision ? parseDraft(candidate.content, value) : null;
      writer.current = new DraftWriter(job.id, value.revision, saved.draft, (message, failed) => setSaveState({ message, failed }));
      finished.current = false;
      setPlan(value); restoreDraft(restored || null, value);
      setSaveState({ message: restored ? 'Draft restored · continue where you left off' : 'No unsaved changes', failed: false });
    })()
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [job.id, job.sourceId, reload]);

  useEffect(() => {
    if (!plan || loading || !initialIssue) return;
    const target = reviewShotTarget(plan, initialIssue, sourceFps);
    setHighlightedShot(target);
    setReviewTime(initialIssue.start);
  }, [plan, loading, initialIssue, sourceFps]);

  useEffect(() => {
    if (!highlightedShot || loading) return;
    const element = dialog.current?.querySelector<HTMLElement>(`[data-review-shot="${CSS.escape(highlightedShot.id)}"]`);
    const details = element?.closest("details");
    if (details) details.open = true;
    element?.scrollIntoView({ block: "nearest" });
    element?.querySelector<HTMLSelectElement>("select")?.focus({ preventScroll: true });
  }, [highlightedShot, loading]);

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
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, video[controls], [tabindex="0"]',
    ) || []).filter((element) => element.checkVisibility() && !element.closest('[hidden]'));
    (focusable()[0] || dialog.current)?.focus({ preventScroll: true });
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
    return () => { window.removeEventListener("keydown", keydown); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);

  const cutTimingsChanged = !!plan && !!draft && differs((promptAnchor?.plan || plan).cuts.map(({ start, end }) => ({ start, end })), draft.cuts.map(({ start, end }) => ({ start, end })));
  const draftChanges = useMemo(() => plan && draft ? collectDraftChanges(plan, draft, refreshBroll, promptAnchor) : null, [plan, draft, refreshBroll, promptAnchor]);
  const changed = !!draftChanges && Object.keys(draftChanges).length > 1;
  const draftKey = useMemo(() => draft ? draftIdentity(draft, refreshBroll, brollCount, brollMaxCoverage) : "", [draft, refreshBroll, brollCount, brollMaxCoverage]);
  const draftSnapshot = useMemo(() => !draft || !plan ? null : changed || brollCount !== savedBrollCount || brollMaxCoverage !== savedCoverage
    ? JSON.stringify({ draft, refreshBroll, brollCount, brollMaxCoverage, promptAnchor, reviewTime }) : null,
    [draft, plan, changed, refreshBroll, brollCount, brollMaxCoverage, promptAnchor]);
  useEffect(() => { if (!loading && !sourceProblem && !draftChoice && !finished.current && writer.current) writer.current.schedule(draftSnapshot); }, [loading, sourceProblem, draftChoice, draftSnapshot]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (writer.current && !writer.current.localSafe) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('beforeunload', unload); void writer.current?.flush(); };
  }, []);
  const explicitVisualChanges = draftChanges?.visuals !== undefined;
  const layoutIssues = useMemo(() => draft ? textLayoutIssues(draft, knownOutputAspect) : [], [draft, knownOutputAspect]);
  const timelineFps = draft?.settings.fps === "source" ? sourceFps || 30 : Number(draft?.settings.fps) || 30;
  const story = useMemo(() => draft ? storyClips(draft, timelineFps) : [], [draft, timelineFps]);
  const timelineDuration = draft ? storyTiming(story, draft.settings.speed).at(-1)?.outputEnd ?? draft.outputDuration : 0;
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
    seekTimeline(outputTimeAt(story, draft!.settings.speed, draft!.cuts.slice(0, index).reduce((sum, cut) => sum + (cut.end - cut.start) / draft!.settings.speed, 0)));
    setPreviewMode("framing");
  };
  const updateVisual = (id: string, changes: Partial<EditPlanVisual>) => setDraft((value) => value && ({
    ...value, visuals: value.visuals.map((visual) => visual.id === id ? { ...visual, ...changes } : visual),
  }));
  const seekReview = (time: number) => {
    setReviewTime(time); setTransportRate(0); setPreviewMode("export");
    if (exportVideo.current) exportVideo.current.currentTime = time;
  };
  const reviewActions = (issue: FinishedIssue) => {
    if (!plan || !draft) return null;
    const target = reviewShotTarget(plan, issue, sourceFps);
    if (!target) return <p className="edit-plan-note">No single supporting shot is identified here. Review the video and adjust the relevant controls.</p>;
    const current = target.kind === "visual" ? draft.visuals.find(item => item.id === target.id) : draft.settings.ownFootage?.find(item => item.id === target.id);
    const original = target.kind === "visual" ? plan.visuals.find(item => item.id === target.id) : plan.settings.ownFootage?.find(item => item.id === target.id);
    const removed = !current || ("enabled" in current && !current.enabled);
    if (removed) return <p className="edit-plan-note">Shot removed from this draft. Render the revision to apply your change.</p>;
    // A saved finding must not remove a replacement the user has already chosen.
    const edited = target.kind === "visual"
      ? differs({ ...current, locked: undefined }, { ...original, locked: undefined }) : differs(current, original);
    const disabled = saving || cutTimingsChanged || refreshBroll || edited;
    return <div className="finished-shot-actions">
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => {
        if (target.kind === "visual") updateVisual(target.id, { enabled: false });
        else setDraft(value => value && ({ ...value, settings: { ...value.settings, ownFootage: value.settings.ownFootage?.filter(item => item.id !== target.id) } }));
        setReviewNotice("Shot removed from the draft. Render the revision to see the result.");
      }}>Remove shot</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => {
        if (target.kind === "visual") updateVisual(target.id, { locked: false });
        setHighlightedShot({ ...target });
        setReviewNotice("Choose a replacement in the highlighted shot, then render the revision.");
      }}>Replace shot</button>
      {edited && <p className="edit-plan-note">This shot has already changed. Render the revision to review it again.</p>}
    </div>;
  };

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
    setTransportRate(0); setReviewTime(0); setSeekToken(value => value + 1);
    setPreviewMode("framing");
    setError("");
  };

  const seekTimeline = (time: number) => {
    if (!draft) return;
    setTransportRate(0); setPreviewMode("framing");
    setReviewTime(Math.max(0, time)); setSeekToken(value => value + 1);
  };
  const historyValue = useMemo(() => draft ? { draft, refreshBroll, brollCount, brollMaxCoverage, promptAnchor } : null, [draft, refreshBroll, brollCount, brollMaxCoverage, promptAnchor]);
  const history = useEditHistory(historyValue, `${job.id}:${reload}`);
  const restoreHistory = (direction: "undo" | "redo") => {
    if (savingRef.current || timelineBusyRef.current) return;
    const snapshot = history[direction](); if (!snapshot) return;
    setDraft(snapshot.draft); setRefreshBroll(snapshot.refreshBroll); setBrollCount(snapshot.brollCount); setBrollCountInput(String(snapshot.brollCount));
    setBrollMaxCoverage(snapshot.brollMaxCoverage); setCoverageInput(String(snapshot.brollMaxCoverage)); setPromptAnchor(snapshot.promptAnchor); setPromptUndo(null);
    setTransportRate(0); setPreviewMode("framing"); setSeekToken(value => value + 1); setError("");
  };
  useEffect(() => {
    if (draft && reviewTime > timelineDuration) { setReviewTime(timelineDuration); setSeekToken(value => value + 1); }
  }, [timelineDuration]);
  const changeTimelineCuts = async (cuts: EditPlan["cuts"], ownFootage?: EditPlan["settings"]["ownFootage"]) => {
    if (!plan || !draft || savingRef.current || timelineBusyRef.current) return;
    timelineBusyRef.current = true; setTimelineBusy(true); setTransportRate(0);
    try {
      const base = collectDraftChanges(plan, draft, refreshBroll, promptAnchor);
      const next = await request<EditPlan>(`/api/jobs/${job.id}/plan/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base, changes: { revision: plan.revision, cuts, ...(ownFootage ? { ownFootage } : {}) } }) });
      // Explicit intervals preserve corrections made before this gesture. Server
      // validation still checks media, bounds and locked shots on final rendering.
      const changes: EditPlanChanges = { ...collectDraftChanges(plan, next, refreshBroll, null), captions: next.captions, visuals: next.visuals };
      setPromptAnchor({ plan: structuredClone(next), changes }); setDraft(next);
      setPreviewMode("framing"); setSeekToken(value => value + 1); setError("");
    } finally { timelineBusyRef.current = false; setTimelineBusy(false); }
  };
  const transport = (command: "toggle" | "pause" | "forward" | "reverse") => {
    setPreviewMode("framing");
    if (reviewTime >= timelineDuration - .001 && (command === "toggle" || command === "forward")) { setReviewTime(0); setSeekToken(value => value + 1); }
    setTransportRate(rate => command === "pause" ? 0 : command === "toggle" ? (rate ? 0 : 1) : command === "forward" ? (rate > 0 ? Math.min(4, rate * 2) : 1) : (rate < 0 ? Math.max(-4, rate * 2) : -1));
  };

  const submit = async (searchAgain = refreshBroll) => {
    if (!plan || !draft || (!changed && !searchAgain) || savingRef.current || timelineBusy) return;
    setError("");
    const changes = collectDraftChanges(plan, draft, searchAgain, promptAnchor);
    if (searchAgain) { changes.brollCount = brollCount; changes.brollMaxCoverage = brollMaxCoverage; }
    try { validateDraftChanges(plan, draft, changes); }
    catch (reason) { setError((reason as Error).message); return; }
    updateCorrectionClock.current();
    changes.correctionSeconds = Math.min(86_400, Math.round(correctionClock.current.totalMs / 1000));
    setTransportRate(0);
    savingRef.current = true;
    setSaving(true);
    try {
      const created = await request<RenderJob>(`/api/jobs/${job.id}/revisions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes),
      });
      finished.current = true; writer.current?.schedule(null); await writer.current?.flush();
      onCreated(created);
    } catch (reason) { setError((reason as Error).message); }
    finally { savingRef.current = false; setSaving(false); }
  };

  return <div className="modal-backdrop edit-plan-backdrop" onClick={() => { if (!savingRef.current) closeEditor(); }}>
    <section ref={dialog} className="edit-plan-modal timeline-editor" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="edit-plan-title" onClick={(event) => event.stopPropagation()}>
      <header className="edit-plan-heading">
        <div><span className="eyebrow">VIDEO EDITOR{plan ? ` · REVISION ${plan.revision}` : ""}</span>
          <h2 id="edit-plan-title">{exportTitle(job)}</h2><p>Arrange your clips below, then render a new revision.</p>
          <p role="status" className={saveState.failed ? 'draft-save-warning' : 'draft-save-state'}>{saveState.message}</p>
          {saveState.failed && <button className="secondary-button" onClick={() => void writer.current?.flush()}>Retry saving draft</button>}</div>
        <button type="button" className="icon-button" aria-label="Close result editor" onClick={closeEditor} disabled={saving}><X size={20} /></button>
      </header>
      {loading ? <div className="edit-plan-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading your edit…</div> :
        draftChoice ? <div className="draft-conflict"><h3>Choose the draft to continue</h3><p>{draftChoice.valid ? 'This browser has changes that differ from the draft saved in another window. Both copies are preserved until you choose.' : 'The browser backup no longer matches this edit. Your server draft is still available.'}</p><button className="secondary-button" onClick={() => { try { localStorage.removeItem(resultDraftKey(job.id)); } catch { /* Schedule retries cleanup. */ } setDraftChoice(null); }}>Use server draft</button>{draftChoice.valid && <button className="secondary-button" onClick={() => { restoreDraft(draftChoice.backup, plan!); setDraftChoice(null); }}>Use browser draft</button>}</div> :
        sourceProblem ? <SourceRecovery job={job} initial={sourceProblem} onImport={onImport} onRecovered={saved => { onRecovered(saved); setReload(value => value + 1); }} /> : plan && draft ? <form ref={form} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="edit-plan-body">
            <aside ref={playbackPane} className="edit-plan-playback" aria-label="Video preview and checks" tabIndex={0}>
              <div className="edit-preview-tabs" aria-label="Preview view">
                <button type="button" aria-pressed={previewMode === "framing"} onClick={() => setPreviewMode("framing")}>Live edit</button>
                <button type="button" aria-pressed={previewMode === "export"} onClick={() => { setTransportRate(0); setPreviewMode("export"); }}>Compare saved export</button>
              </div>
              {previewMode === "export" ? <>
                <video ref={exportVideo} style={{ height: previewHeight, maxHeight: previewHeight, objectFit: "contain" }} src={`/api/jobs/${job.id}/video`} controls playsInline preload="metadata" aria-label="Current exported video" onLoadedMetadata={event => { event.currentTarget.currentTime = Math.min(reviewTime, event.currentTarget.duration); }} />
                <p className="draft-preview-note">Saved export · The timeline below is your live edit. Click its ruler to return to editing.</p>
              </> : <TimelinePreview plan={draft} job={timelineJob} time={reviewTime} seekToken={seekToken} rate={transportRate} onRate={setTransportRate} onTime={setReviewTime} onSeek={seekTimeline} height={previewHeight} fps={timelineFps} onAspect={setKnownOutputAspect} guide={platformGuide} guideBottom={guideBottom} guideRight={guideRight} />}
            </aside>
            <div className="edit-plan-fields" role="region" aria-label="Edit controls" tabIndex={0} inert={saving || timelineBusy}>
              <div className="edit-inspector-heading"><h3>Inspector</h3><p>Use the timeline to cut and move clips. Open a section here to change their look or text.</p></div>
              <details className="edit-plan-section edit-prompt-section"><summary>Edit with a prompt <span>AI</span></summary>
              <PromptEditor contextKey={`${job.id}:${plan.revision}:${draftKey}`} disabled={saving || timelineBusy} onSuggest={suggestEdit} onApply={applyPrompt}
                examples={savedEditExamples(draft)}
                applied={!!promptUndo} canUndo={!!promptUndo && promptUndo.appliedIdentity === draftKey} onUndo={() => {
                  if (!promptUndo || promptUndo.appliedIdentity !== draftKey) return;
                  setDraft(structuredClone(promptUndo.draft)); setRefreshBroll(promptUndo.refreshBroll); setBrollCount(promptUndo.brollCount); setBrollCountInput(String(promptUndo.brollCount)); setBrollMaxCoverage(promptUndo.brollMaxCoverage); setCoverageInput(String(promptUndo.brollMaxCoverage)); setPromptAnchor(promptUndo.anchor); setPromptUndo(null); setError("");
                  setTransportRate(0); setReviewTime(0); setSeekToken(value => value + 1);
                }} />
              </details>
              <details className="edit-plan-section edit-framing-section">
                <summary>Framing &amp; caption placement</summary>
                <fieldset disabled={saving}>
                  <legend className="visually-hidden">Framing and caption style</legend>
                  <label className="edit-plan-field">Platform interface guide
                    <select value={platformGuide} onChange={event => { const guide = event.target.value as typeof platformGuide; setPlatformGuide(guide); setGuideBottom(guide === "tiktok" ? 24 : 22); setGuideRight(guide === "tiktok" ? 18 : 16); }}><option value="off">Off</option><option value="instagram">Instagram Reels</option><option value="tiktok">TikTok</option></select>
                  </label>
                  {platformGuide !== "off" && <div className="edit-guide-adjustments">
                    <label className="edit-framing-slider"><span>Bottom occupied area<output>{guideBottom}%</output></span><input type="range" min={5} max={40} value={guideBottom} onChange={event => setGuideBottom(event.target.valueAsNumber)} /></label>
                    <label className="edit-framing-slider"><span>Right occupied area<output>{guideRight}%</output></span><input type="range" min={5} max={30} value={guideRight} onChange={event => setGuideRight(event.target.valueAsNumber)} /></label>
                    <p className="edit-plan-note">Preview guides only. Platform controls vary by device.</p>
                  </div>}
                  <UpscaleControl value={draft.settings.upscale} onChange={upscale => updateFraming({ upscale })} />
                  <BlackBandsEditor value={draft.settings.blackBands} onChange={blackBands => updateFraming({ blackBands })} />
                  {!draft.settings.blackBands?.enabled && <label className="edit-plan-field">Fit source footage
                    <select value={draft.settings.fit} onChange={(event) => updateFraming({ fit: event.target.value as RemixSettings["fit"] })}>
                      <option value="crop">Fill frame with a crop</option><option value="contain">Keep the whole video</option><option value="blur">Keep whole video with blurred background</option>
                    </select>
                  </label>}
                  <p className="edit-plan-note">Choose the subject's position within the original picture. Crop positions move the visible area when the frame is filled; each cut can have its own position.</p>
                  <FocalControls label="Default crop position" value={focalPoint} onChange={(point) => updateFraming({ focalPoint: point })} disabled={(draft.settings.blackBands?.enabled ? draft.settings.blackBands.fit : draft.settings.fit) === "contain"} />
                  {!!layoutIssues.length && <div className="edit-layout-issues" role="status"><strong><AlertTriangle size={14} />Text placement to review</strong><ul>{layoutIssues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></div>}
                </fieldset>
              </details>
              <details className="edit-plan-section"><summary>Opening title</summary><fieldset disabled={saving}>
                <legend className="visually-hidden">Opening hook</legend>
                <label className="edit-plan-field">Text shown at the start
                  <textarea rows={2} maxLength={120} value={draft.settings.hookText} onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, hookText: event.target.value } })} />
                </label>
              </fieldset></details>
              <details className="edit-plan-section">
                <summary>Captions <span>{draft.captions.length}</span></summary>
                <p className="edit-plan-note">Removing added captions keeps any captions already baked into the original video.</p>
                {cutTimingsChanged && <p className="edit-plan-note">Render your new cut points first. Caption and B-roll timings will follow the revised cuts automatically.</p>}
                <fieldset disabled={saving || cutTimingsChanged}>
                  <legend className="visually-hidden">Caption corrections</legend>
                  <CaptionStyleEditor value={draft.settings.captionStyle} showPreview={false} onChange={captionStyle => updateFraming({ captionStyle })} />
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

                <fieldset disabled={saving}>
                  <legend className="visually-hidden">Source cut boundaries</legend>
                  {draft.cuts.map((cut, index) => <div className="edit-plan-cut" key={index}><div className="edit-cut-heading"><strong>Cut {index + 1}</strong><button className="secondary-button" type="button" onClick={() => { seekTimeline(outputTimeAt(story, draft.settings.speed, draft.cuts.slice(0,index).reduce((sum, cut) => sum + (cut.end-cut.start)/draft.settings.speed, 0))); }}>Preview crop</button></div>
                    <fieldset disabled={saving || timelineBusy}><legend className="visually-hidden">Cut {index + 1} timing</legend><div className="edit-plan-times">
                    {(["start", "end"] as const).map((edge) => <label className="edit-plan-field" key={edge}>{edge === "start" ? "Start" : "End"} (s)
                      <input aria-label={`Cut ${index + 1} ${edge} in seconds`} type="number" required min={0} max={plan.sourceDuration} step="any" key={`${index}-${edge}-${cut[edge]}`} defaultValue={Number.isFinite(cut[edge]) ? cut[edge] : ""} onBlur={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value !== cut[edge]) void changeTimelineCuts(draft.cuts.map((item, itemIndex) => itemIndex === index ? withTrackBounds({ ...item, [edge]: value }) : item)).catch(reason => setError(reason.message)); }} />
                    </label>)}
                    </div></fieldset>
                    <label className="edit-plan-check edit-custom-crop"><input type="checkbox" checked={!!cut.focalPoint} onChange={(event) => updateCutFraming(index, event.target.checked ? { ...focalPoint } : undefined)} />Custom crop position for this cut</label>
                    <FocalControls label={`Cut ${index + 1} crop position`} value={cut.focalPoint || focalPoint} disabled={!cut.focalPoint || draft.settings.fit === "contain"} onChange={(point) => updateCutFraming(index, point)} />
                  </div>)}
                </fieldset>
              </details>
              <OwnFootagePanel value={draft.settings.ownFootage} savedAssets={job.footageAssets} disabled={saving} highlightedId={highlightedShot?.kind === "footage" ? highlightedShot.id : undefined} onChange={ownFootage => setDraft({ ...draft, settings: { ...draft.settings, ownFootage } })} />
              <details className="edit-plan-section">
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
                    return <article data-review-shot={visual.id} className={`edit-plan-visual ${visual.enabled ? "" : "is-removed"} ${highlightedShot?.id === visual.id ? "review-highlight" : ""}`} key={visual.id}>
                      <div className="edit-plan-visual-heading"><h3><Film size={15} /> Shot {index + 1}</h3>
                        <label className="edit-plan-check"><input type="checkbox" checked={visual.enabled} onChange={(event) => updateVisual(visual.id, { enabled: event.target.checked })} />Include shot</label>
                      </div>
                      {media?.url && <FootagePreview key={`${media.id}:${previewStart}:${previewEnd}`} url={media.url} label={`Preview shot ${index + 1}`} start={previewStart} end={previewEnd} aspect={previewAspect} focalPoint={visual.focalPoint || CENTER} height={230} />}
                      {media?.kind === "graphic" && media.visualSource && <p className="edit-plan-note">{VISUAL_SOURCE_LABELS[media.visualSource]} · {media.graphicScene ? GRAPHIC_KIND_LABELS[media.graphicScene.kind] : "Animated card"}</p>}
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
                      {media?.graphicScene && <p className="edit-plan-note">Spoken evidence: {media.graphicScene.nodes.map(node => `“${node.quote}”`).join(" · ")}</p>}
                      {media?.attribution && <p className="edit-plan-credit">Video by {media.attribution.creator} on <a href={media.attribution.url} target="_blank" rel="noreferrer">{media.attribution.provider}</a>{media.stock?.licenseUrl && <> · <a href={media.stock.licenseUrl} target="_blank" rel="noreferrer">License</a></>}</p>}
                    </article>;
                  })}
                </fieldset>
              </details>
              <details className="edit-review-details" open={!!initialIssue}><summary>Review notes for the saved export</summary>
              <QualityReportSummary report={job.qualityReport} />
              <FinishedReviewSummary report={job.finishedReviewReport} compact={!initialIssue} onSeek={seekReview} issueActions={reviewActions} />
              {reviewNotice && <p className="edit-plan-note" role="status">{reviewNotice}</p>}
              {changed ? <p className="editorial-coverage">Your draft changes have not received an editorial check. The saved export's findings are available in Exports and History. Render the revision to review its final result.</p>
                : <EditorialReportSummary report={job.editorialReport} repair={job.editorialRepair} />}
              </details>
            </div>
          </div>
          <EditTimeline jobId={job.id} job={timelineJob} plan={draft} time={reviewTime} fps={timelineFps} onSeek={seekTimeline} onImported={rememberFootage} onBusy={setTimelineBusy}
            onChange={next => { setDraft(next); setTransportRate(0); setPreviewMode("framing"); }} onCuts={changeTimelineCuts} disabled={saving || timelineBusy || refreshBroll}
            canUndo={history.canUndo} canRedo={history.canRedo} onUndo={() => restoreHistory("undo")} onRedo={() => restoreHistory("redo")} onTransport={transport} />
          <footer className="edit-plan-footer">
            <div><p>Your original stays available. Render to save this edit as a new export.</p>{refreshBroll && <p className="edit-plan-pending-search">A stock search will request {brollCount} total supporting shots. {promptAnchor?.changes.preserveBroll ? "All existing shots will be kept." : "Saved animations and uploaded B-roll will be kept."}</p>}{error && <ProblemNotice message={error} operation="Edit export" />}</div>
            <div className="edit-plan-buttons"><button type="button" className="secondary-button" disabled={saving || timelineBusy || (!changed && brollCount === savedBrollCount && brollMaxCoverage === savedCoverage)} onClick={() => { setDraft(structuredClone(plan)); setTransportRate(0); setReviewTime(0); setSeekToken(value => value + 1); setRefreshBroll(false); setBrollCount(savedBrollCount); setBrollCountInput(String(savedBrollCount)); setBrollMaxCoverage(savedCoverage); setCoverageInput(String(savedCoverage)); setPromptAnchor(null); setPromptUndo(null); setReviewNotice(""); setError(""); }}><RotateCcw size={14} />Reset changes</button>
              <button className="primary-button" type="submit" disabled={saving || timelineBusy || !changed}>{saving ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}{saving ? "Queuing revision…" : "Render new revision"}</button></div>
          </footer>
        </form> : <div className="edit-plan-loading"><ProblemNotice message={error || "This edit is unavailable."} operation="Load edit" /><button className="secondary-button" onClick={() => setReload((value) => value + 1)}>Try again</button></div>}
    </section>
  </div>;
}
