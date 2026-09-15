export type Aspect = "original" | "9:16" | "1:1" | "4:5" | "16:9";
export interface FocalPoint { x: number; y: number }
export interface CaptionStyle { fontSize: number; bottomPercent: number }
export interface QualityIssue { code: string; message: string; start?: number; end?: number }
export interface QualityReport { status: "pass" | "review"; checkedAt: string; scope: "full" | "sampled"; issues: QualityIssue[] }
export interface EditSegment {
  start: number;
  end: number;
  focalPoint?: FocalPoint;
}
export interface TimedCallout {
  text: string;
  start: number;
  end: number;
}
export const MAX_AUTO_VERSIONS = 10;
export interface AutoOptions {
  aspect: Aspect;
  targetDuration: 30 | 45 | 60;
  narration: boolean;
  supportingVisuals?: "off" | "stock" | "library" | "graphics" | "both";
  stockVideoType?: "all" | "animation";
  brollIds?: string[];
  brollMatching?: "tags" | "ai";
}
export const DEFAULT_AUTO_OPTIONS: AutoOptions = {
  aspect: "9:16",
  targetDuration: 45,
  narration: false,
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
  narration: boolean;
  motionGraphics?: boolean;
  brollAI?: boolean;
  brollAIModel?: string;
  stockBroll?: boolean;
  message?: string;
}
export interface RemixSettings {
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
  segments?: EditSegment[];
  callouts?: TimedCallout[];
  normalizeAudio?: boolean;
  /** Mild local denoising and sharpening, without a cloud service. */
  qualityCleanup?: boolean;
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
}
export interface BrollAsset extends VideoSource {
  tags: string[];
  attribution?: { provider: "Pixabay"; creator: string; url: string };
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
  id: string;
  name: string;
  kind: "broll" | "graphic" | "audio";
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
  visuals: EditPlanVisual[];
  media: EditPlanMedia[];
  audioMediaId?: string;
  narration: boolean;
}
export interface EditPlanChanges {
  revision: number;
  refreshBroll?: boolean;
  hookText?: string;
  captions?: CaptionCue[];
  cuts?: EditSegment[];
  visuals?: EditPlanVisual[];
  framing?: { fit?: RemixSettings["fit"]; focalPoint?: FocalPoint; captionStyle?: CaptionStyle };
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
export interface ExportReview {
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
export interface PostMetrics {
  platform: "instagram" | "tiktok";
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
  publications: { platform: "instagram" | "tiktok"; publishedAt: string; url?: string }[];
  available?: boolean;
  measurements?: ExportMeasurements;
  corrections?: CorrectionRecord;
}
export interface Attachment {
  id: string;
  name: string;
  kind: "audio" | "subtitle";
}
export type JobStatus =
  "queued" | "processing" | "completed" | "failed" | "cancelled" | "skipped";
export interface RenderJob {
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
  downloadUrl?: string;
  outputSize?: number;
  editable?: boolean;
  revision?: number;
  parentJobId?: string;
  auto?: AutoOptions;
  qualityReport?: QualityReport;
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
    kind: "broll" | "graphic";
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
