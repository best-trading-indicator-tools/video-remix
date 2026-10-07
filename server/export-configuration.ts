import { createHash } from "node:crypto";
import type { ExportConfiguration } from "../shared/types.js";
import type { StoredJob } from "./store.js";
import { blackBandFinishSchema } from "../shared/black-bands.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function exportConfiguration(job: StoredJob, duration: number): ExportConfiguration {
  const settings = structuredClone(job.editPlan?.settings ?? job.settings);
  const auto = job.auto ? structuredClone(job.auto) : undefined;
  const intervals = (job.supportingVisuals || []).map(shot => [Math.max(0, shot.start), Math.min(duration, shot.end)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0]);
  let covered = 0, last = 0;
  for (const [start, end] of intervals) { covered += Math.max(0, end - Math.max(last, start)); last = Math.max(last, end); }
  const actual = {
    ...(settings.ownFootage?.length ? { ownFootage: settings.ownFootage.map(item => ({ name: job.footageFiles?.[item.assetId]?.name || "Uploaded footage", at: item.at, start: item.start, end: item.end, mode: item.mode, ...(item.appendToEnd ? { appendToEnd: true } : {}) })) } : {}),
    captions: job.editPlan?.captionMode ?? (job.captionPath ? "added" : "not recorded"),
    narration: Boolean(job.summary?.narration),
    visualCount: intervals.length,
    visualCoveragePercent: Math.round(1000 * covered / duration) / 10,
    visualSources: [...new Set((job.supportingVisuals || []).map(shot => shot.visualSource || shot.stock?.providerId?.split(":")[0] || (shot.kind === "graphic" ? "graphics" : "library")))].sort(),
  };
  // Compare editing choices independently of the selected words, times, IDs and subject positions.
  const { ownFootage, segments, hookText, trimStart, trimEnd, callouts, audioId, subtitleId, focalPoint, secondaryFocalPoint, blackBands, watermarkRemoval, ...profile } = settings;
  const { brollIds, ownFootage: _autoFootage, blackBands: autoBands, watermarkRemoval: autoRemoval, ...autoProfile } = auto || {};
  const profileId = createHash("sha256").update(canonical({ version: 1, profile, auto: auto ? autoProfile : null,
    ...(blackBands ? { blackBands: blackBandFinishSchema.parse(blackBands) } : {}),
    ...(autoBands ? { autoBlackBands: blackBandFinishSchema.parse(autoBands) } : {}),
    ...(watermarkRemoval?.enabled ? { watermarkRemoval: watermarkRemoval.mode } : {}),
    ...(autoRemoval?.enabled ? { autoWatermarkRemoval: autoRemoval.mode } : {}),
    ownFootage: ownFootage?.map(({ mode, audio, fit, appendToEnd }) => ({ mode, audio, fit, ...(appendToEnd ? { appendToEnd: true } : {}) })),
    hook: Boolean(hookText), soundtrack: Boolean(audioId), subtitles: Boolean(subtitleId) })).digest("hex").slice(0, 12);
  return { version: 1, profileId, settings, ...(auto ? { auto } : {}), actual };
}
