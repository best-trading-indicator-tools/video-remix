export type Aspect = "original" | "9:16" | "1:1" | "4:5" | "16:9";
export interface EditSegment {
  start: number;
  end: number;
}
export interface TimedCallout {
  text: string;
  start: number;
  end: number;
}
export interface AutoOptions {
  aspect: Aspect;
  targetDuration: 30 | 45 | 60;
  narration: boolean;
  supportingVisuals?: "off" | "library" | "graphics" | "both";
  brollIds?: string[];
}
export const DEFAULT_AUTO_OPTIONS: AutoOptions = {
  aspect: "9:16",
  targetDuration: 45,
  narration: false,
};
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
  autoMotion?: boolean;
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
}
export interface BrollAsset extends VideoSource {
  tags: string[];
}
export interface Attachment {
  id: string;
  name: string;
  kind: "audio" | "subtitle";
}
export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";
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
  auto?: AutoOptions;
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
  }[];
}
export interface Health {
  ok: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  maxFileSize: number;
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
