import type { GraphicScene } from "./graphic-scene.js";
import type { FinishedReviewReport } from "./finished-review.js";
import type { VisualIdentity, HistoryMatch } from "./visual-identity.js";
import type { PacingOptions } from "./pacing.js";
import type { OwnFootagePlacement, OwnFootageAsset } from "./own-footage.js";
import type { EditorialReport } from "./editorial.js";
import type { EditorialRepairLog, EditorialReviewProgress } from "./editorial-repair.js";
import type { CaptionStyle } from "./caption-style.js";
import type { AutoAudioMode } from "./audio.js";
import type { BlackBands } from "./black-bands.js";
export type { CaptionStyle } from "./caption-style.js";
export type Aspect = "original" | "9:16" | "1:1" | "4:5" | "16:9";
export interface FocalPoint { x: number; y: number }
/** A subject center in source coordinates, at an original source timestamp. */
export interface FocusKeyframe extends FocalPoint { time: number }
export interface QualityIssue { code: string; message: string; start?: number; end?: number }
export interface QualityReport { status: "pass" | "review"; checkedAt: string; scope: "full" | "sampled"; issues: QualityIssue[] }
export interface EditSegment {
  start: number;
  end: number;
  focalPoint?: FocalPoint;
  focusTrack?: FocusKeyframe[];
}
export interface TimedCallout {
  text: string;
  start: number;
  end: number;
}
export const MAX_AUTO_VERSIONS = 10;
export const isAutoTargetDuration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
export const DEFAULT_BROLL_COUNT = 4;
export const MAX_BROLL_COUNT = 10;
export const DEFAULT_BROLL_MAX_COVERAGE = 60;
export type VisualSource = "pixabay" | "pexels" | "hyperframes" | "remotion" | "library";
export interface AutoOptions {
  blackBands?: BlackBands;
  ownFootage?: OwnFootagePlacement[];
  aspect: Aspect;
  /** Maximum output length in whole seconds, starting at 1. */
  targetDuration: number;
  narration: boolean;
  pacing?: PacingOptions;
  /** Auto checks for burned-in captions; keep adds none; add explicitly generates captions. */
  captions?: "auto" | "add" | "keep";
  captionStyle?: CaptionStyle;
  supportingVisuals?: "off" | "stock" | "library" | "graphics" | "both";
  /** Independent sources to mix. An empty list keeps the original footage. */
  visualSources?: VisualSource[];
  stockVideoType?: "all" | "animation";
  brollIds?: string[];
  brollMatching?: "tags" | "ai";
  /** Requested total; additional search/placement passes try to fill every slot. */
  brollCount?: number;
  /** Maximum percent of the output covered by stock, library shots and animation cards. */
  brollMaxCoverage?: number;
  /**
   * Sound treatment for the selected speech. Auto measures the edit and applies
   * the closest-fitting sound look; a look id pins that choice instead.
   */
  audio?: AutoAudioMode;
  /** Independent review of the final selected speech; unavailable checks remain visible. */
  editorialMode?: "off" | "check" | "repair";
  finishedReview?: boolean;
}
export const DEFAULT_AUTO_OPTIONS: AutoOptions = {
  aspect: "9:16",
  targetDuration: 45,
  brollMaxCoverage: DEFAULT_BROLL_MAX_COVERAGE,
  narration: false,
  captions: "auto",
  audio: "auto",
  editorialMode: "repair",
  pacing: { mode: "natural", minimumPause: 0.9, keepPause: 0.35, removeFillers: false },
};
export interface AutoBatchItem {
  sourceId: string;
  variants?: number;
  options?: AutoOptions;
}
export type AutoBatchRequest =
  | { items: AutoBatchItem[] }
  | { sourceIds: string[]; variants?: number; options?: AutoOptions };
export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  probability?: number;
}
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}
export interface Transcript {
  language: string;
  duration: number;
  segments: TranscriptSegment[];
}
export interface AutoCapabilities {
  transcription: boolean;
  model: string;
  intelligence: boolean;
  intelligenceProvider?: "deepseek";
  intelligenceModel?: string;
  narration: boolean;
  motionGraphics?: boolean;
  remotionGraphics?: boolean;
  brollAI?: boolean;
  brollAIModel?: string;
  stockBroll?: boolean;
  stockProviders?: ("pixabay" | "pexels")[];
  message?: string;
}
export interface RemixSettings {
  blackBands?: BlackBands;
  ownFootage?: OwnFootagePlacement[];
  speed: number;
  volume: number;
  muted: boolean;
  zoom: number;
  saturation: number;
  brightness: number;
  contrast: number;
  hue: number;
  gamma: number;
  temperature: number;
  noise: number;
  sharpness: number;
  blend: number;
  frameBlend: number;
  timeShift: number;
  mirror: boolean;
  aspect: Aspect;
  fit: "crop" | "contain" | "blur";
  resolution: "source" | "720" | "1080";
  fps: "source" | "24" | "30" | "60";
  trimStart: number;
  trimEnd: number | null;
  hookText: string;
  hookDuration: number;
  stripMetadata: boolean;
  device: string;
  audioId: string | null;
  subtitleId: string | null;
  /** Manual exports transcribe their final soundtrack locally. */
  automaticCaptions?: "off" | "auto" | "add";
  segments?: EditSegment[];
  callouts?: TimedCallout[];
  normalizeAudio?: boolean;
  /**
   * Sound-look modifiers, all neutral when absent. Ranges live in shared/audio.ts:
   * denoise/lowCut/compression/deEss 0–1, bass/presence/treble -1–1.
   */
  denoise?: number;
  lowCut?: number;
  bass?: number;
  presence?: number;
  treble?: number;
  compression?: number;
  deEss?: number;
  /** Seconds of silence-to-full and full-to-silence on the finished soundtrack. */
  fadeIn?: number;
  fadeOut?: number;
  smoothCuts?: boolean;
  /** Mild local denoising and sharpening, without a cloud service. */
  qualityCleanup?: boolean;
  layout?: "single" | "split" | "presentation";
  secondaryFocalPoint?: FocalPoint;
  autoMotion?: boolean;
  focalPoint?: FocalPoint;
  captionStyle?: CaptionStyle;
}
export const DEFAULT_SETTINGS: RemixSettings = {
  speed: 1,
  volume: 1,
  muted: false,
  zoom: 1,
  saturation: 1,
  brightness: 0,
  contrast: 1,
  hue: 0,
  gamma: 1,
  temperature: 0,
  noise: 0,
  sharpness: 0,
  blend: 0,
  frameBlend: 0,
  timeShift: 0,
  mirror: false,
  aspect: "original",
  fit: "crop",
  resolution: "source",
  fps: "source",
  trimStart: 0,
  trimEnd: null,
  hookText: "",
  hookDuration: 3,
  stripMetadata: true,
  device: "none",
  audioId: null,
  subtitleId: null,
};
export interface VideoSource {
  id: string;
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  createdAt: string;
  thumbnailUrl: string;
  url: string;
  fingerprint?: string;
  previousExports?: number;
  similarExports?: number;
}
export interface BrollAsset extends VideoSource {
  tags: string[];
  attribution?: { provider: "Pixabay" | "Pexels"; creator: string; url: string };
  selection?: {
    sourceStart: number;
    duration: number;
    targetAspect: number;
    motion: number;
    cropRetention: number;
    query?: string;
    reason?: string;
    visual?: string;
    momentIndex?: number;
  };
  stock?: {
    providerId: string;
    rendition: string;
    contentHash: string;
    retrievedAt: string;
    licenseUrl: string;
  };
}
export interface CaptionCue { id: string; start: number; end: number; text: string }
export interface EditPlanMedia {
  graphicScene?: GraphicScene;
  id: string;
  name: string;
  kind: "broll" | "graphic" | "audio";
  visualSource?: VisualSource;
  duration: number;
  url?: string;
  assetId?: string;
  attribution?: BrollAsset["attribution"];
  selection?: BrollAsset["selection"];
  stock?: BrollAsset["stock"];
}
export interface EditPlanVisual {
  id: string;
  mediaId: string;
  start: number;
  end: number;
  sourceStart: number;
  enabled: boolean;
  locked: boolean;
  reason?: string;
  focalPoint?: FocalPoint;
}
export interface EditPlan {
  version: 1;
  /** Older plans treated numeric resolutions as caps; migrated/new plans use exact output sizes. */
  resolutionSizing?: "exact";
  revision: number;
  sourceId: string;
  sourceDuration: number;
  outputDuration: number;
  createdAt: string;
  settings: RemixSettings;
  cuts: EditSegment[];
  captions: CaptionCue[];
  /** Prevent cut changes or automatic repairs from restoring deliberately omitted captions. */
  captionMode?: "generated" | "off";
  visuals: EditPlanVisual[];
  media: EditPlanMedia[];
  audioMediaId?: string;
  narration: boolean;
}
export interface EditPlanChanges {
  ownFootage?: OwnFootagePlacement[];
  revision: number;
  refreshBroll?: boolean;
  /** Add stock in unused slots while retaining every saved shot. */
  preserveBroll?: boolean;
  /** New stock search target; only supplied with refreshBroll. */
  brollCount?: number;
  /** Maximum percent of the output covered by stock, library shots and animation cards. */
  brollMaxCoverage?: number;
  hookText?: string;
  captions?: CaptionCue[];
  cuts?: EditSegment[];
  visuals?: EditPlanVisual[];
  framing?: { fit?: RemixSettings["fit"]; focalPoint?: FocalPoint; captionStyle?: CaptionStyle; blackBands?: BlackBands };
  correctionSeconds?: number;
}
export interface PromptEditRequest {
  revision: number;
  prompt: string;
  draft?: EditPlanChanges;
}
export interface PromptEditResponse {
  revision: number;
  changes: EditPlanChanges;
  plan: EditPlan;
  summary: string[];
  clarification?: string;
}
export interface ManualPromptEditRequest { prompt: string; settings: RemixSettings }
export interface ManualPromptEditResponse { settings: RemixSettings; summary: string[]; clarification?: string }
export interface ExportReview {
  /** Human judgment of the whole short; absence means no acceptance decision was recorded. */
  verdict?: "accepted-unchanged" | "accepted-after-correction" | "rejected";
  issueReasons?: ("opening" | "ending" | "meaning" | "hook" | "captions" | "framing" | "broll" | "other")[];
  benchmarkCase?: string;
  approach?: string;
  openingClear?: boolean;
  endingComplete?: boolean;
  brollReviewed?: number;
  brollAccepted?: number;
  captionCorrections?: number;
  correctionSeconds?: number;
  notes?: string;
}
export type PublishingPlatform = "instagram" | "tiktok" | "youtube";
export type ReachAssessment = "unknown" | "normal" | "suspected" | "confirmed" | "resolved";
export interface Publication {
  id?: string;
  platform: PublishingPlatform;
  publishedAt: string;
  account?: string;
  url?: string;
}
export interface ExportConfiguration {
  version: 1;
  profileId: string;
  settings: RemixSettings;
  auto?: AutoOptions;
  actual: { captions: string; narration: boolean; visualCount: number; visualCoveragePercent: number; visualSources: string[];
    ownFootage?: { name: string; at: number; start: number; end: number; mode: "insert" | "cover"; appendToEnd?: boolean }[] };
}
export interface PostMetrics {
  platform: PublishingPlatform;
  publicationId?: string;
  reachAssessment?: ReachAssessment;
  feedback?: string;
  measuredAt: string;
  views?: number;
  averageWatchSeconds?: number;
  completionPercent?: number;
  saves?: number;
  shares?: number;
  platformNotice?: string;
}
export interface ExportMeasurements {
  review?: ExportReview;
  posts?: PostMetrics[];
}
export interface CorrectionRecord { captionCorrections: number; brollChanges: number; seconds?: number }
export interface ExportHistoryEntry {
  draftReview?: DraftReview;
  finishedReviewReport?: FinishedReviewReport;
  sourcePicture?: VisualIdentity;
  outputPicture?: VisualIdentity;
  match?: HistoryMatch;
  configuration?: ExportConfiguration;
  editorialMode?: AutoOptions["editorialMode"];
  id: string;
  jobId: string;
  sourceId: string;
  sourceFingerprint: string;
  sourceName: string;
  title: string;
  cuts: EditSegment[];
  sourceText: string;
  outputDuration: number;
  createdAt: string;
  revision: number;
  parentJobId?: string;
  stockShots: { identity: string; name: string; sourceStart: number; duration: number }[];
  publications: Publication[];
  available?: boolean;
  /** A retained frame of this export, independent of the temporary video file. */
  thumbnailUrl?: string;
  thumbnailKind?: "export" | "source";
  measurements?: ExportMeasurements;
  corrections?: CorrectionRecord;
  editorialReport?: EditorialReport;
  editorialRepair?: EditorialRepairLog;
}
export interface Attachment {
  id: string;
  name: string;
  kind: "audio" | "subtitle";
}
export type JobStatus =
  "queued" | "processing" | "completed" | "failed" | "cancelled" | "skipped";
export interface DraftReview { summary: string; contribution: string; approvedAt: string }
export interface RenderJob {
  draftReview?: DraftReview;
  /** Provider work has no measurable completion percentage. */
  editorialProgress?: EditorialReviewProgress & { startedAt: string; budgetMs: number };
  /** Live work counters; visual preparation has no reliable percentage or ETA. */
  visualSearch?: { startedAt: string; budgetMs: number; pass: number; maxPasses: number; requested: number; placed: number };
  finishedReviewReport?: FinishedReviewReport;
  footageAssets?: OwnFootageAsset[];
  visualFulfillment?: { requested: number; placed: number; attempts: number; reason?: string };
  /** Mode actually used, kept separate from unset legacy preferences. */
  editorialModeApplied?: AutoOptions["editorialMode"];
  id: string;
  sourceId: string;
  sourceName: string;
  variant: number;
  batchId: string;
  status: JobStatus;
  progress: number;
  settings: RemixSettings;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  /** Explicit user cancellation, persisted before stopping the worker. */
  cancelledByUser?: boolean;
  retry?: {
    count: number;
    limit: number;
    cause: "failure" | "restart";
    reason: string;
    lastPhase?: string;
    nextRetryAt?: string;
    stopped?: "limit" | "needs-attention";
  };
  downloadUrl?: string;
  outputSize?: number;
  editable?: boolean;
  revision?: number;
  parentJobId?: string;
  auto?: AutoOptions;
  qualityReport?: QualityReport;
  editorialReport?: EditorialReport;
  editorialRepair?: EditorialRepairLog;
  corrections?: CorrectionRecord;
  phase?: string;
  summary?: {
    title: string;
    changes: string[];
    sourceDuration: number;
    outputDuration: number;
    transcriptAvailable: boolean;
    usedAI: boolean;
    narration: boolean;
  };
  notes?: string[];
  captionUrl?: string;
  supportingVisuals?: {
    graphicScene?: GraphicScene;    kind: "broll" | "graphic";
    visualSource?: VisualSource;
    name: string;
    start: number;
    end: number;
    assetId?: string;
    attribution?: BrollAsset["attribution"];
    sourceStart?: number;
    reason?: string;
    selection?: BrollAsset["selection"];
    stock?: BrollAsset["stock"];
  }[];
}
export interface Health {
  ok: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  maxFileSize: number;
  maxLargeFileSize: number;
  importChunkSize: number;
  maxFiles: number;
  concurrency: number;
  retentionHours: number;
}
export function randomizeSettings(base: RemixSettings): RemixSettings {
  const between = (a: number, b: number) =>
    Math.round((a + Math.random() * (b - a)) * 100) / 100;
  const clamp = (value: number, low: number, high: number) =>
    Math.round(Math.max(low, Math.min(high, value)) * 100) / 100;
  return {
    ...base,
    speed: clamp(base.speed * between(0.96, 1.04), 0.5, 2),
    zoom: clamp(base.zoom * between(0.98, 1.06), 1, 2),
    saturation: clamp(base.saturation * between(0.95, 1.08), 0, 3),
    brightness: clamp(base.brightness + between(-0.02, 0.02), -1, 1),
    contrast: clamp(base.contrast * between(0.97, 1.05), 0, 2),
    temperature: clamp(base.temperature + between(-0.05, 0.05), -1, 1),
  };
}
