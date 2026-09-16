import { ownFootageSchema, type OwnFootagePlacement } from "./own-footage.js";
import { pacingCutSignature, pacingReviewSchema, type PacingReview } from "./pacing.js";
import { DEFAULT_SETTINGS, type FocalPoint, type FocusKeyframe, type RemixSettings, type VideoSource } from "./types.js";
import { MAX_FOCUS_POINTS_TOTAL, validFocusTrack } from "./focus.js";

export const SHORT_DRAFT_STORAGE = "remix-short-drafts-v1";
export const MAX_SHORTS = 100;
export const MAX_SHORT_CUTS = 60;
export interface ShortCut { id: string; start: string; end: string; focalPoint?: FocalPoint; focusTrack?: FocusKeyframe[] }
export interface ShortFocusAnalysis {
  signature: string;
  status: "tracked" | "partial" | "no-face" | "unavailable";
  multipleFaces: boolean;
  reason?: string;
}
export interface ShortDraft {
  ownFootage?: OwnFootagePlacement[];
  id: string;
  sourceId: string;
  sourceFingerprint?: string;
  sourceName: string;
  title: string;
  cuts: ShortCut[];
  aspect: RemixSettings["aspect"];
  fit: RemixSettings["fit"];
  resolution: RemixSettings["resolution"];
  zoom: number;
  focalPoint: FocalPoint;
  autoFocus?: boolean;
  focusMode?: "face" | "speaker";
  focusAnalysis?: ShortFocusAnalysis;
  normalizeAudio: boolean;
  qualityCleanup: boolean;
  layout?: RemixSettings["layout"];
  secondaryFocalPoint?: FocalPoint;
  pacingReview?: PacingReview;
  updatedAt: string;
}
export interface ShortDraftStore { version: 1; drafts: ShortDraft[] }

/** Face centers are independent of output aspect/zoom, but belong to these exact source cuts and starting point. */
export function shortFocusSignature(draft: ShortDraft): string {
  return JSON.stringify({ sourceId: draft.sourceId, mode: draft.focusMode || "face", seed: draft.focalPoint,
    cuts: draft.cuts.map(cut => ({ id: cut.id, start: cut.start, end: cut.end, focalPoint: cut.focalPoint })) });
}

/** Crop bounds use source coordinates and the renderer's even-pixel crop sizing. */
export function shortCropGuide(
  source: Pick<VideoSource, "width" | "height">,
  aspect: RemixSettings["aspect"],
  zoom: number,
  focalPoint: FocalPoint,
  resolution: RemixSettings["resolution"] = "1080",
): { width: number; height: number; left: number; top: number; minX: number; maxX: number; minY: number; maxY: number; canMoveX: boolean; canMoveY: boolean } {
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const sourceWidth = even(source.width), sourceHeight = even(source.height);
  const [across, down] = aspect === "original" ? [source.width, source.height] : aspect.split(":").map(Number);
  const requestedAspect = across! / down!;
  // Output geometry is rounded before its ratio is written into FFmpeg's crop
  // expression. Using the requested aspect directly can select two extra pixels.
  let outputWidth = source.width, outputHeight = source.height;
  if (resolution !== "source") {
    const edge = Number(resolution);
    outputWidth = requestedAspect >= 1 ? even(edge * requestedAspect) : edge;
    outputHeight = requestedAspect >= 1 ? edge : even(edge / requestedAspect);
  } else {
    if (source.width / source.height > requestedAspect) outputWidth = source.height * requestedAspect;
    else outputHeight = source.width / requestedAspect;
    outputWidth = even(outputWidth); outputHeight = even(outputHeight);
  }
  const targetAspect = Number((outputWidth / outputHeight).toFixed(8));
  const scale = Number.isFinite(zoom) ? Math.max(1, Math.min(2, zoom)) : 1;
  const cropWidth = even(Math.min(sourceWidth, sourceHeight * targetAspect) / scale);
  const cropHeight = even(Math.min(sourceHeight, sourceWidth / targetAspect) / scale);
  const width = cropWidth / sourceWidth, height = cropHeight / sourceHeight;
  return {
    width, height,
    left: Math.max(0, Math.min(1 - width, focalPoint.x - width / 2)),
    top: Math.max(0, Math.min(1 - height, focalPoint.y - height / 2)),
    minX: width / 2, maxX: 1 - width / 2,
    minY: height / 2, maxY: 1 - height / 2,
    // An even-pixel rounding sliver does not offer useful positioning travel.
    canMoveX: sourceWidth - cropWidth > 2, canMoveY: sourceHeight - cropHeight > 2,
  };
}

/** Source clocks accept seconds, MM:SS or HH:MM:SS, with millisecond precision. */
export function parseSourceClock(input: string): number | null {
  const value = input.trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value)) return null;
  const parts = value.split(":").map(Number);
  if (parts.length > 1 && parts.at(-1)! >= 60) return null;
  if (parts.length === 3 && parts[1] >= 60) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) && seconds <= 86400 ? seconds : null;
}
export function formatSourceClock(seconds: number): string {
  const millis = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor(millis / 60000) % 60;
  const secs = Math.floor(millis / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis % 1000).padStart(3, "0")}`;
}
export function createShortDraft(source: VideoSource, id: string, cutId: string, start = 0, index = 1): ShortDraft {
  const position = Math.max(0, Math.min(Math.max(0, source.duration - 0.05), start));
  return {
    id, sourceId: source.id, sourceFingerprint: source.fingerprint, sourceName: source.name,
    title: `Short ${index}`, cuts: [{ id: cutId, start: formatSourceClock(position), end: formatSourceClock(Math.min(source.duration, position + 30)) }],
    aspect: "9:16", fit: "crop", resolution: "1080", zoom: 1, focalPoint: { x: 0.5, y: 0.5 },
    autoFocus: false, focusMode: "face", focusAnalysis: undefined,
    layout: "single", secondaryFocalPoint: undefined,
    normalizeAudio: false, qualityCleanup: false, updatedAt: new Date().toISOString(),
  };
}
export function validateShortDraft(draft: ShortDraft, source?: VideoSource): { errors: string[]; duration: number; settings: RemixSettings | null } {
  const errors: string[] = [];
  if (!source || source.id !== draft.sourceId) errors.push("The source is unavailable. Reimport it, then reconnect this short.");
  if (!draft.title.trim()) errors.push("Give this short a name.");
  if (/[\u0000-\u001f\u007f]/.test(draft.title)) errors.push("Use a short name without control characters.");
  if (draft.title.length > 100) errors.push("Short names can contain up to 100 characters.");
  if (!draft.cuts.length || draft.cuts.length > MAX_SHORT_CUTS) errors.push(`Choose between 1 and ${MAX_SHORT_CUTS} sequences.`);
  const zoom = draft.zoom ?? 1;
  if (!Number.isFinite(zoom) || zoom < 1 || zoom > 2) errors.push("Zoom must be between 1 and 2.");
  const tracking = draft.autoFocus === true && draft.fit === "crop";
  const analysisReady = draft.focusAnalysis?.signature === shortFocusSignature(draft);
  if (tracking && !analysisReady) errors.push("Automatic centering is being prepared. Wait for it to finish or switch it off.");
  if (tracking && draft.cuts.reduce((sum, cut) => sum + (cut.focusTrack?.length ?? 0), 0) > MAX_FOCUS_POINTS_TOTAL)
    errors.push("This short contains too many focus points. Retry automatic centering.");
  const segments = draft.cuts.flatMap((cut, index) => {
    const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
    if (start === null || end === null) { errors.push(`Sequence ${index + 1}: enter valid start and end timestamps.`); return []; }
    if (end <= start + 0.04) errors.push(`Sequence ${index + 1}: the end must be at least 0.05 seconds after the start.`);
    if (source && (start >= source.duration || end > source.duration + 0.001)) errors.push(`Sequence ${index + 1}: timestamps must stay within the source video.`);
    if (tracking && cut.focusTrack && !validFocusTrack(cut.focusTrack, start, end))
      errors.push(`Sequence ${index + 1}: retry automatic centering for these timestamps.`);
    return [{ start, end, ...(cut.focalPoint ? { focalPoint: cut.focalPoint } : {}),
      ...(tracking && analysisReady && cut.focusTrack ? { focusTrack: cut.focusTrack } : {}) }];
  });
  const duration = segments.reduce((sum, cut) => sum + Math.max(0, cut.end - cut.start), 0);
  const settings: RemixSettings = {
    ...DEFAULT_SETTINGS, ...(draft.ownFootage ? { ownFootage: draft.ownFootage } : {}), aspect: draft.aspect, fit: draft.fit, resolution: draft.resolution, zoom,
    segments, focalPoint: draft.focalPoint, normalizeAudio: draft.normalizeAudio, qualityCleanup: draft.qualityCleanup,
    layout: draft.layout, secondaryFocalPoint: draft.secondaryFocalPoint,
    smoothCuts: !!draft.pacingReview?.appliedSignature && draft.pacingReview.appliedSignature === pacingCutSignature(draft.cuts),
  };
  return { errors, duration, settings: errors.length ? null : settings };
}

/** A reimport may have a new source ID. Only identical content is suggested automatically. */
export function matchingShortSource(draft: ShortDraft, sources: VideoSource[]): VideoSource | undefined {
  return sources.find(source => source.id === draft.sourceId) || (draft.sourceFingerprint ? sources.find(source => source.fingerprint === draft.sourceFingerprint) : undefined);
}
export function reconnectShortDraft(draft: ShortDraft, source: VideoSource): ShortDraft {
  return { ...draft, sourceId: source.id, sourceFingerprint: source.fingerprint, sourceName: source.name, updatedAt: new Date().toISOString() };
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const focal = (value: unknown): value is FocalPoint => record(value) && typeof value.x === "number" && typeof value.y === "number" && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;
/** Defensively restore known fields; invalid timestamp text remains visible and cannot render. */
export function restoreShortDrafts(input: unknown): ShortDraft[] {
  if (!record(input) || input.version !== 1 || !Array.isArray(input.drafts)) return [];
  const ids = new Set<string>();
  return input.drafts.slice(0, MAX_SHORTS).flatMap(value => {
    if (!record(value) || typeof value.id !== "string" || ids.has(value.id) || typeof value.sourceId !== "string" || typeof value.sourceName !== "string" || typeof value.title !== "string" || !Array.isArray(value.cuts) || value.cuts.length > MAX_SHORT_CUTS) return [];
    const cuts: ShortCut[] = [];
    const cutIds = new Set<string>();
    for (const cut of value.cuts) {
      if (!record(cut) || typeof cut.id !== "string" || cutIds.has(cut.id) || typeof cut.start !== "string" || typeof cut.end !== "string") return [];
      cutIds.add(cut.id);
      const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
      const focusTrack = Array.isArray(cut.focusTrack) && start !== null && end !== null && validFocusTrack(cut.focusTrack, start, end)
        ? cut.focusTrack as FocusKeyframe[] : undefined;
      cuts.push({ id: cut.id, start: cut.start.slice(0, 32), end: cut.end.slice(0, 32), ...(focal(cut.focalPoint) ? { focalPoint: cut.focalPoint } : {}), ...(focusTrack ? { focusTrack } : {}) });
    }
    ids.add(value.id);
    const pacing = pacingReviewSchema.safeParse(value.pacingReview);
    const validPacing = pacing.success && pacing.data.baseCuts.every(cut => {
      const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
      return start !== null && end !== null && end - start >= 0.05;
    }) && pacing.data.removals.every(removal => {
      const cut = pacing.data.baseCuts[removal.cutIndex];
      return removal.start >= parseSourceClock(cut.start)! && removal.end <= parseSourceClock(cut.end)!;
    });
    return [{
      id: value.id, sourceId: value.sourceId, sourceName: value.sourceName.slice(0, 500),
      sourceFingerprint: typeof value.sourceFingerprint === "string" ? value.sourceFingerprint : undefined,
      title: value.title.slice(0, 101), cuts,
      ...(value.ownFootage !== undefined && ownFootageSchema.safeParse(value.ownFootage).success ? { ownFootage: ownFootageSchema.parse(value.ownFootage) } : {}),
      aspect: (["original", "9:16", "1:1", "4:5", "16:9"].includes(String(value.aspect)) ? value.aspect : "9:16") as ShortDraft["aspect"],
      fit: (["crop", "contain", "blur"].includes(String(value.fit)) ? value.fit : "crop") as ShortDraft["fit"],
      resolution: (["source", "720", "1080"].includes(String(value.resolution)) ? value.resolution : "1080") as ShortDraft["resolution"],
      zoom: typeof value.zoom === "number" && Number.isFinite(value.zoom) && value.zoom >= 1 && value.zoom <= 2 ? value.zoom : 1,
      focalPoint: focal(value.focalPoint) ? value.focalPoint : { x: 0.5, y: 0.5 },
      autoFocus: value.autoFocus === true,
      focusMode: value.focusMode === "speaker" ? "speaker" : "face",
      focusAnalysis: record(value.focusAnalysis) && typeof value.focusAnalysis.signature === "string" && value.focusAnalysis.signature.length <= 20_000 &&
        ["tracked", "partial", "no-face", "unavailable"].includes(String(value.focusAnalysis.status)) &&
        cuts.reduce((sum, cut) => sum + (cut.focusTrack?.length ?? 0), 0) <= MAX_FOCUS_POINTS_TOTAL &&
        !value.cuts.some((cut, index) => record(cut) && cut.focusTrack !== undefined && !cuts[index]?.focusTrack)
        ? { signature: value.focusAnalysis.signature, status: value.focusAnalysis.status as ShortFocusAnalysis["status"],
          multipleFaces: value.focusAnalysis.multipleFaces === true,
          reason: typeof value.focusAnalysis.reason === "string" ? value.focusAnalysis.reason.slice(0, 500) : undefined } : undefined,
      normalizeAudio: value.normalizeAudio === true, qualityCleanup: value.qualityCleanup === true,
      layout: value.layout === "split" || value.layout === "presentation" ? value.layout : "single",
      secondaryFocalPoint: focal(value.secondaryFocalPoint) ? value.secondaryFocalPoint : undefined,
      ...(validPacing ? { pacingReview: pacing.data } : {}),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    }];
  });
}
