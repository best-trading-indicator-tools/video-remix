import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { finished } from "node:stream/promises";
import { z } from "zod";
import type { EditSegment, ExportHistoryEntry } from "../shared/types.js";
import type { EditorialPlan } from "./diversity.js";
import type { StoredJob, StoredSource } from "./store.js";
import { cutsDuration, retimeTranscript } from "./auto-plan.js";
import { exportConfiguration } from "./export-configuration.js";
import { validPublicationUrl } from "../shared/publishing.js";
import { similarPicture } from "./visual-identity.js";
import { footageTimeline } from "../shared/own-footage.js";

/** Content identity survives a rename/reimport; memory usage stays bounded. */
export async function fingerprintFile(filePath: string, signal?: AbortSignal, onBytes?: (bytes: number) => void): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024, signal });
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk);
      bytes += chunk.length;
      onBytes?.(bytes);
    }
    signal?.throwIfAborted();
    return hash.digest("hex");
  } finally {
    stream.destroy();
    await finished(stream, { cleanup: true }).catch(() => undefined);
  }
}

function renderedCuts(source: StoredSource, job: StoredJob): EditSegment[] {
  const saved = job.editPlan?.cuts || job.settings.segments;
  if (saved) return structuredClone(saved);
  const end = Math.min(job.settings.trimEnd ?? source.duration, source.duration);
  const duration = end - job.settings.trimStart;
  // Match the renderer's clamped trim shift for older/manual exports as well.
  const start = Math.max(0, Math.min(job.settings.trimStart + job.settings.timeShift, source.duration - duration));
  return [{ start, end: start + duration }];
}

const validCut = (cut: EditSegment) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.start >= 0 && cut.end > cut.start;
const clean = (text: string) => text.replace(/\s+/gu, " ").trim();
function stockIdentity(visual: NonNullable<StoredJob["supportingVisuals"]>[number]): string | undefined {
  if (visual.stock?.providerId) return visual.stock.providerId;
  if (visual.stock?.rendition) {
    try {
      const url = new URL(visual.stock.rendition);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch { /* Never store a local filename as a stock identity. */ }
  }
  return visual.assetId ? `library:${visual.assetId}` : undefined;
}

/** A small completed-export record with no dependency on retained media files. */
export function historyEntry(source: StoredSource, job: StoredJob): ExportHistoryEntry | null {
  if (!source.fingerprint || job.status !== "completed") return null;
  const cuts = renderedCuts(source, job);
  if (!cuts.length || cuts.some(cut => !validCut(cut) || cut.end > source.duration + 0.001)) return null;
  const outputDuration = job.summary?.outputDuration ?? footageTimeline(job.settings.ownFootage, cutsDuration(cuts) / job.settings.speed, job.settings.fps === "source" ? source.fps : Number(job.settings.fps)).duration;
  if (!Number.isFinite(outputDuration) || outputDuration <= 0) return null;
  const sourceText = job.sourceTranscript
    ? clean(retimeTranscript(job.sourceTranscript, cuts).segments.map(segment => segment.text).join(" "))
    : "";
  const stockShots = (job.supportingVisuals || []).flatMap(visual => {
    if (visual.kind !== "broll") return [];
    const identity = stockIdentity(visual);
    const sourceStart = visual.sourceStart ?? visual.selection?.sourceStart ?? 0;
    const duration = visual.end - visual.start;
    if (!identity || !Number.isFinite(sourceStart) || sourceStart < 0 || !Number.isFinite(duration) || duration <= 0) return [];
    return [{ identity, name: visual.name, sourceStart, duration }];
  });
  return {
    id: job.id,
    jobId: job.id,
    sourceId: source.id,
    sourceFingerprint: source.fingerprint,
    ...(source.picture ? { sourcePicture: source.picture } : {}),
    ...(job.outputPicture ? { outputPicture: job.outputPicture } : {}),
    sourceName: source.name,
    title: job.summary?.title || job.settings.hookText || source.name,
    ...(job.draftReview ? { draftReview: structuredClone(job.draftReview) } : {}),
    cuts,
    sourceText,
    outputDuration,
    createdAt: job.finishedAt || job.createdAt,
    revision: job.editPlan?.revision ?? job.revision ?? 1,
    ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
    stockShots,
    publications: [],
    configuration: exportConfiguration(job, outputDuration),
    ...(job.finishedReviewReport ? { finishedReviewReport: structuredClone(job.finishedReviewReport) } : {}),
    ...(job.corrections ? { corrections: structuredClone(job.corrections) } : {}),
    ...(job.editorialReport ? { editorialReport: structuredClone(job.editorialReport) } : {}),
    ...(job.editorialRepair ? { editorialRepair: structuredClone(job.editorialRepair) } : {}),
    // Do not assign today's default mode to legacy exports during reconciliation.
    ...((job.editorialModeApplied || job.editorialRepair || job.editorialReport) ? {
      editorialMode: job.editorialModeApplied ?? (job.editorialRepair ? "repair" : "check"),
    } : {}),
  };
}

/** Reconciliation/retry may revisit a job; publication notes belong to its ledger entry. */
export function upsertHistory(entries: ExportHistoryEntry[], entry: ExportHistoryEntry): ExportHistoryEntry[] {
  const prior = entries.filter(item => item.jobId === entry.jobId);
  const publications = prior.length ? prior.flatMap(item => item.publications) : entry.publications;
  const distinctPublications = publications.filter((item, index) => !publications.slice(0, index).some(previous =>
    item.id ? previous.id === item.id : !previous.id && previous.platform === item.platform && previous.account === item.account && previous.publishedAt === item.publishedAt && previous.url === item.url));
  const measurements = prior.find(item => item.measurements)?.measurements ?? entry.measurements;
  const configuration = prior.find(item => item.configuration)?.configuration ?? entry.configuration;
  const thumbnailUrl = entry.thumbnailUrl ?? prior.find(item => item.thumbnailUrl)?.thumbnailUrl;
  const thumbnailKind = entry.thumbnailKind ?? prior.find(item => item.thumbnailUrl)?.thumbnailKind;
  const updated = structuredClone({ ...entry,
    sourcePicture: entry.sourcePicture ?? prior.find(item => item.sourcePicture)?.sourcePicture,
    outputPicture: entry.outputPicture ?? prior.find(item => item.outputPicture)?.outputPicture, configuration, publications: distinctPublications, ...(measurements ? { measurements } : {}),
    ...(thumbnailUrl ? { thumbnailUrl, ...(thumbnailKind ? { thumbnailKind } : {}) } : {}) });
  const result: ExportHistoryEntry[] = [];
  let inserted = false;
  for (const existing of entries) {
    if (existing.jobId === entry.jobId) {
      if (!inserted) result.push(updated);
      inserted = true;
    } else result.push(structuredClone(existing));
  }
  if (!inserted) result.push(updated);
  return result;
}

/** All ledger records originate from completed exports, even after their files expire. */
export function previousEditorialPlans(entries: ExportHistoryEntry[], sourceFingerprint: string): EditorialPlan[] {
  if (!sourceFingerprint) return [];
  return entries.filter(entry => entry.sourceFingerprint === sourceFingerprint && entry.cuts.length && entry.cuts.every(validCut))
    .map(entry => ({ cuts: structuredClone(entry.cuts), text: entry.sourceText }));
}

/** Fuzzy picture matches are review hints only; never reserve cuts or block a render. */
export function relatedHistory(entries: ExportHistoryEntry[], source: Pick<StoredSource, "fingerprint" | "picture">): ExportHistoryEntry[] {
  return entries.flatMap<ExportHistoryEntry>(entry => {
    if (source.fingerprint && entry.sourceFingerprint === source.fingerprint) return [{ ...entry, match: { kind: "exact" as const } }];
    const output = similarPicture(source.picture, entry.outputPicture);
    if (output) return [{ ...entry, match: { kind: "similar-export" as const, ...output } }];
    const original = similarPicture(source.picture, entry.sourcePicture);
    return original ? [{ ...entry, match: { kind: "similar-source" as const, ...original } }] : [];
  });
}

const publication = z.object({
  id: z.uuid().optional(),
  platform: z.enum(["instagram", "tiktok", "youtube"]),
  account: z.string().trim().max(100).optional(),
  publishedAt: z.iso.datetime({ offset: true }),
  url: z.string().url().max(2000).optional(),
}).strict().refine(item => {
  if (!item.url) return true;
  return validPublicationUrl(item.platform, item.url);
}, "Use an HTTPS link on the selected platform without credentials or a custom port");

export const publicationChangesSchema = z.object({ publications: z.array(publication).max(50)
  .refine(items => new Set(items.flatMap(item => item.id ? [item.id] : [])).size === items.filter(item => item.id).length, "Publication IDs must be unique") }).strict();
