import { DEFAULT_SETTINGS, type FocalPoint, type RemixSettings, type VideoSource } from "./types.js";

export const SHORT_DRAFT_STORAGE = "remix-short-drafts-v1";
export const MAX_SHORTS = 100;
export const MAX_SHORT_CUTS = 60;
export interface ShortCut { id: string; start: string; end: string; focalPoint?: FocalPoint }
export interface ShortDraft {
  id: string;
  sourceId: string;
  sourceFingerprint?: string;
  sourceName: string;
  title: string;
  cuts: ShortCut[];
  aspect: RemixSettings["aspect"];
  fit: RemixSettings["fit"];
  resolution: RemixSettings["resolution"];
  focalPoint: FocalPoint;
  normalizeAudio: boolean;
  qualityCleanup: boolean;
  updatedAt: string;
}
export interface ShortDraftStore { version: 1; drafts: ShortDraft[] }

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
    aspect: "9:16", fit: "crop", resolution: "1080", focalPoint: { x: 0.5, y: 0.5 },
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
  const segments = draft.cuts.flatMap((cut, index) => {
    const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
    if (start === null || end === null) { errors.push(`Sequence ${index + 1}: enter valid start and end timestamps.`); return []; }
    if (end <= start + 0.04) errors.push(`Sequence ${index + 1}: the end must be at least 0.05 seconds after the start.`);
    if (source && (start >= source.duration || end > source.duration + 0.001)) errors.push(`Sequence ${index + 1}: timestamps must stay within the source video.`);
    return [{ start, end, ...(cut.focalPoint ? { focalPoint: cut.focalPoint } : {}) }];
  });
  const duration = segments.reduce((sum, cut) => sum + Math.max(0, cut.end - cut.start), 0);
  const settings: RemixSettings = {
    ...DEFAULT_SETTINGS, aspect: draft.aspect, fit: draft.fit, resolution: draft.resolution,
    segments, focalPoint: draft.focalPoint, normalizeAudio: draft.normalizeAudio, qualityCleanup: draft.qualityCleanup,
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
      cuts.push({ id: cut.id, start: cut.start.slice(0, 32), end: cut.end.slice(0, 32), ...(focal(cut.focalPoint) ? { focalPoint: cut.focalPoint } : {}) });
    }
    ids.add(value.id);
    return [{
      id: value.id, sourceId: value.sourceId, sourceName: value.sourceName.slice(0, 500),
      sourceFingerprint: typeof value.sourceFingerprint === "string" ? value.sourceFingerprint : undefined,
      title: value.title.slice(0, 101), cuts,
      aspect: (["original", "9:16", "1:1", "4:5", "16:9"].includes(String(value.aspect)) ? value.aspect : "9:16") as ShortDraft["aspect"],
      fit: (["crop", "contain", "blur"].includes(String(value.fit)) ? value.fit : "crop") as ShortDraft["fit"],
      resolution: (["source", "720", "1080"].includes(String(value.resolution)) ? value.resolution : "1080") as ShortDraft["resolution"],
      focalPoint: focal(value.focalPoint) ? value.focalPoint : { x: 0.5, y: 0.5 },
      normalizeAudio: value.normalizeAudio === true, qualityCleanup: value.qualityCleanup === true,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    }];
  });
}
