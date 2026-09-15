import { z } from "zod";
import type { CorrectionRecord, EditPlan, ExportHistoryEntry, PostMetrics } from "../shared/types.js";

const count = z.number().finite().int().min(0).max(1_000_000_000_000);
const corrections = z.number().finite().int().min(0).max(100_000);
const seconds = z.number().finite().min(0).max(86_400);
const text = (maximum: number) => z.string().trim().max(maximum)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Use plain text without control characters");
const verdictSchema = z.enum(["accepted-unchanged", "accepted-after-correction", "rejected"]);
const issueReasonSchema = z.enum(["opening", "ending", "meaning", "hook", "captions", "framing", "broll", "other"]);
const issueReasonsSchema = z.array(issueReasonSchema).max(8)
  .refine(reasons => new Set(reasons).size === reasons.length, "Record each issue reason once");
const reviewSchema = z.object({
  verdict: verdictSchema.optional(),
  issueReasons: issueReasonsSchema.optional(),
  benchmarkCase: text(80).optional(),
  approach: text(80).optional(),
  openingClear: z.boolean().optional(),
  endingComplete: z.boolean().optional(),
  brollReviewed: corrections.optional(),
  brollAccepted: corrections.optional(),
  captionCorrections: corrections.optional(),
  correctionSeconds: seconds.optional(),
  notes: text(500).optional(),
}).strict().refine(review => (review.brollReviewed === undefined) === (review.brollAccepted === undefined),
  "Supply both the number of B-roll shots reviewed and the number accepted")
  .refine(review => review.brollAccepted === undefined || review.brollAccepted <= review.brollReviewed!,
    "Accepted B-roll shots cannot exceed reviewed shots");
const postSchema = z.object({
  platform: z.enum(["instagram", "tiktok"]),
  measuredAt: z.iso.datetime({ offset: true }),
  views: count.optional(),
  averageWatchSeconds: seconds.optional(),
  completionPercent: z.number().finite().min(0).max(100).optional(),
  saves: count.optional(),
  shares: count.optional(),
  platformNotice: text(500).optional(),
}).strict();

/** Replace the submitted measurement document; unspecified metrics stay unknown. */
export const measurementsSchema = z.object({
  review: reviewSchema.optional(),
  posts: z.array(postSchema).max(20).optional(),
}).strict();

/** Count changed caption content and shot decisions, excluding timing-only captions and lock toggles. */
export function correctionRecord(before: EditPlan, after: EditPlan, elapsedSeconds?: number): CorrectionRecord {
  const beforeCaptions = new Map(before.captions.map(cue => [cue.id, cue]));
  const afterCaptions = new Map(after.captions.map(cue => [cue.id, cue]));
  let captionCorrections = 0;
  const removed: string[] = [];
  const added: string[] = [];
  for (const cue of before.captions) {
    const next = afterCaptions.get(cue.id);
    if (!next) removed.push(cue.text);
    else if (next.text !== cue.text) captionCorrections++;
  }
  for (const cue of after.captions) if (!beforeCaptions.has(cue.id)) added.push(cue.text);
  // Regenerated IDs with identical text do not establish a content correction.
  const remainingAdded = [...added];
  for (const prior of removed) {
    const identical = remainingAdded.indexOf(prior);
    if (identical >= 0) remainingAdded.splice(identical, 1);
    else captionCorrections++;
  }
  captionCorrections += remainingAdded.length;
  const beforeVisuals = new Map(before.visuals.map(visual => [visual.id, visual]));
  const afterVisuals = new Map(after.visuals.map(visual => [visual.id, visual]));
  const beforeMedia = new Map(before.media.map(item => [item.id, item]));
  const afterMedia = new Map(after.media.map(item => [item.id, item]));
  let brollChanges = 0;
  for (const id of new Set([...beforeVisuals.keys(), ...afterVisuals.keys()])) {
    const prior = beforeVisuals.get(id);
    const next = afterVisuals.get(id);
    if (beforeMedia.get(prior?.mediaId || "")?.kind !== "broll" && afterMedia.get(next?.mediaId || "")?.kind !== "broll") continue;
    if (!prior || !next || prior.enabled !== next.enabled || prior.mediaId !== next.mediaId ||
      ["start", "end", "sourceStart"].some(key => Math.abs(prior[key as "start"] - next[key as "start"]) > 0.000001) ||
      Math.abs((prior.focalPoint?.x ?? 0.5) - (next.focalPoint?.x ?? 0.5)) > 0.000001 ||
      Math.abs((prior.focalPoint?.y ?? 0.5) - (next.focalPoint?.y ?? 0.5)) > 0.000001) brollChanges++;
  }
  return { captionCorrections, brollChanges,
    ...(elapsedSeconds === undefined ? {} : { seconds: seconds.parse(elapsedSeconds) }) };
}

export interface PostMeasurementStats {
  posts: number;
  postsWithViews: number;
  totalViews: number | null;
  postsWithWatchTime: number;
  watchTimeViews: number;
  averageWatchSeconds: number | null;
  postsWithCompletion: number;
  completionViews: number;
  completionPercent: number | null;
  postsWithSaves: number;
  totalSaves: number | null;
  postsWithShares: number;
  totalShares: number | null;
  platformNotices: number;
}
export interface MeasurementStats extends PostMeasurementStats {
  exports: number;
  reviewedExports: number;
  verdictReviews: number;
  unknownAcceptanceExports: number;
  acceptedUnchanged: number;
  acceptedAfterCorrection: number;
  rejected: number;
  /** Only explicit whole-short verdicts form the denominator for both rates. */
  acceptanceRate: number | null;
  unchangedAcceptanceRate: number | null;
  openingReviews: number;
  openingClear: number;
  openingClearRate: number | null;
  endingReviews: number;
  endingComplete: number;
  endingCompleteRate: number | null;
  brollReviewExports: number;
  brollReviewed: number;
  brollAccepted: number;
  brollAcceptanceRate: number | null;
  captionMeasuredExports: number;
  captionCorrections: number;
  averageCaptionCorrections: number | null;
  brollChangedExports: number;
  brollChanges: number;
  correctionTimeExports: number;
  correctionSeconds: number;
  averageCorrectionSeconds: number | null;
  medianCorrectionSeconds: number | null;
  platforms: (PostMeasurementStats & { platform: PostMetrics["platform"] })[];
}
export interface MeasurementSummary {
  totals: MeasurementStats;
  groups: (MeasurementStats & { approach: string | null; benchmarkCase: string | null })[];
}

function nonnegative(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}
function whole(value: unknown): value is number { return nonnegative(value) && Number.isInteger(value); }
function label(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function measuredCorrections(entry: ExportHistoryEntry) {
  const review = entry.measurements?.review;
  return {
    captions: whole(review?.captionCorrections) ? review.captionCorrections
      : whole(entry.corrections?.captionCorrections) ? entry.corrections.captionCorrections : undefined,
    broll: whole(entry.corrections?.brollChanges) ? entry.corrections.brollChanges : undefined,
    seconds: nonnegative(review?.correctionSeconds, 86400) ? review.correctionSeconds
      : nonnegative(entry.corrections?.seconds, 86400) ? entry.corrections.seconds : undefined,
  };
}

/** Later array entries win timestamp ties; snapshots are never summed together. */
function latestPosts(entry: ExportHistoryEntry): PostMetrics[] {
  const latest = new Map<PostMetrics["platform"], PostMetrics>();
  for (const post of entry.measurements?.posts || []) {
    if (!post || !["instagram", "tiktok"].includes(post.platform) || !Number.isFinite(Date.parse(post.measuredAt))) continue;
    const previous = latest.get(post.platform);
    if (!previous || Date.parse(post.measuredAt) >= Date.parse(previous.measuredAt)) latest.set(post.platform, post);
  }
  return [...latest.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}

function summarizePosts(posts: PostMetrics[]): PostMeasurementStats {
  const stats: PostMeasurementStats = {
    posts: posts.length, postsWithViews: 0, totalViews: null, postsWithWatchTime: 0, watchTimeViews: 0, averageWatchSeconds: null,
    postsWithCompletion: 0, completionViews: 0, completionPercent: null,
    postsWithSaves: 0, totalSaves: null, postsWithShares: 0, totalShares: null, platformNotices: 0,
  };
  let watchedSeconds = 0;
  let completedPercent = 0;
  for (const post of posts) {
    if (whole(post.views)) { stats.postsWithViews++; stats.totalViews = (stats.totalViews ?? 0) + post.views; }
    if (nonnegative(post.averageWatchSeconds, 86400)) {
      stats.postsWithWatchTime++;
      if (whole(post.views) && post.views > 0) {
        stats.watchTimeViews += post.views;
        watchedSeconds += post.averageWatchSeconds * post.views;
      }
    }
    if (nonnegative(post.completionPercent, 100)) {
      stats.postsWithCompletion++;
      if (whole(post.views) && post.views > 0) {
        stats.completionViews += post.views;
        completedPercent += post.completionPercent * post.views;
      }
    }
    if (whole(post.saves)) { stats.postsWithSaves++; stats.totalSaves = (stats.totalSaves ?? 0) + post.saves; }
    if (whole(post.shares)) { stats.postsWithShares++; stats.totalShares = (stats.totalShares ?? 0) + post.shares; }
    if (label(post.platformNotice)) stats.platformNotices++;
  }
  stats.averageWatchSeconds = stats.watchTimeViews > 0 ? watchedSeconds / stats.watchTimeViews : null;
  stats.completionPercent = stats.completionViews > 0 ? completedPercent / stats.completionViews : null;
  return stats;
}

function summarize(entries: ExportHistoryEntry[]): MeasurementStats {
  const stats: MeasurementStats = {
    exports: entries.length, reviewedExports: 0, openingReviews: 0, openingClear: 0, openingClearRate: null,
    verdictReviews: 0, unknownAcceptanceExports: entries.length, acceptedUnchanged: 0, acceptedAfterCorrection: 0, rejected: 0,
    acceptanceRate: null, unchangedAcceptanceRate: null,
    endingReviews: 0, endingComplete: 0, endingCompleteRate: null,
    brollReviewExports: 0, brollReviewed: 0, brollAccepted: 0, brollAcceptanceRate: null,
    captionMeasuredExports: 0, captionCorrections: 0, averageCaptionCorrections: null,
    brollChangedExports: 0, brollChanges: 0, correctionTimeExports: 0, correctionSeconds: 0, averageCorrectionSeconds: null, medianCorrectionSeconds: null,
    ...summarizePosts([]), platforms: [],
  };
  const correctionTimes: number[] = [];
  for (const entry of entries) {
    const review = entry.measurements?.review;
    const verdict = verdictSchema.safeParse(review?.verdict);
    const issues = issueReasonsSchema.safeParse(review?.issueReasons);
    if (verdict.success) {
      stats.verdictReviews++;
      stats.unknownAcceptanceExports--;
      if (verdict.data === "accepted-unchanged") stats.acceptedUnchanged++;
      else if (verdict.data === "accepted-after-correction") stats.acceptedAfterCorrection++;
      else stats.rejected++;
    }
    if (review && (verdict.success || (issues.success && issues.data.length > 0) || typeof review.openingClear === "boolean" || typeof review.endingComplete === "boolean" ||
      whole(review.brollReviewed) || whole(review.captionCorrections) || nonnegative(review.correctionSeconds, 86400) || label(review.notes))) stats.reviewedExports++;
    if (typeof review?.openingClear === "boolean") {
      stats.openingReviews++;
      if (review.openingClear) stats.openingClear++;
    }
    if (typeof review?.endingComplete === "boolean") {
      stats.endingReviews++;
      if (review.endingComplete) stats.endingComplete++;
    }
    if (whole(review?.brollReviewed) && whole(review?.brollAccepted) && review.brollAccepted <= review.brollReviewed) {
      stats.brollReviewExports++;
      stats.brollReviewed += review.brollReviewed;
      stats.brollAccepted += review.brollAccepted;
    }
    const correction = measuredCorrections(entry);
    if (correction.captions !== undefined) {
      stats.captionMeasuredExports++;
      stats.captionCorrections += correction.captions;
    }
    if (correction.broll !== undefined) {
      stats.brollChangedExports++;
      stats.brollChanges += correction.broll;
    }
    if (correction.seconds !== undefined) {
      stats.correctionTimeExports++;
      stats.correctionSeconds += correction.seconds;
      correctionTimes.push(correction.seconds);
    }
  }
  const posts = entries.flatMap(latestPosts);
  Object.assign(stats, summarizePosts(posts));
  stats.platforms = (["instagram", "tiktok"] as const).map(platform => ({
    platform, ...summarizePosts(posts.filter(post => post.platform === platform)),
  }));
  const ratio = (value: number, denominator: number) => denominator > 0 ? value / denominator : null;
  stats.acceptanceRate = ratio(stats.acceptedUnchanged + stats.acceptedAfterCorrection, stats.verdictReviews);
  stats.unchangedAcceptanceRate = ratio(stats.acceptedUnchanged, stats.verdictReviews);
  stats.openingClearRate = ratio(stats.openingClear, stats.openingReviews);
  stats.endingCompleteRate = ratio(stats.endingComplete, stats.endingReviews);
  stats.brollAcceptanceRate = ratio(stats.brollAccepted, stats.brollReviewed);
  stats.averageCaptionCorrections = ratio(stats.captionCorrections, stats.captionMeasuredExports);
  stats.averageCorrectionSeconds = ratio(stats.correctionSeconds, stats.correctionTimeExports);
  correctionTimes.sort((a, b) => a - b);
  const middle = Math.floor(correctionTimes.length / 2);
  stats.medianCorrectionSeconds = correctionTimes.length === 0 ? null : correctionTimes.length % 2
    ? correctionTimes[middle]! : (correctionTimes[middle - 1]! + correctionTimes[middle]!) / 2;
  return stats;
}

/** Keep denominators visible: unreviewed exports and missing post metrics are not zeros. */
export function measurementSummary(entries: ExportHistoryEntry[]): MeasurementSummary {
  const groups = new Map<string, { approach: string | null; benchmarkCase: string | null; entries: ExportHistoryEntry[] }>();
  for (const entry of entries) {
    const approach = label(entry.measurements?.review?.approach);
    const benchmarkCase = label(entry.measurements?.review?.benchmarkCase);
    const key = JSON.stringify([approach, benchmarkCase]);
    const group = groups.get(key) || { approach, benchmarkCase, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return { totals: summarize(entries), groups: [...groups.values()]
    .sort((a, b) => (a.approach || "").localeCompare(b.approach || "") || (a.benchmarkCase || "").localeCompare(b.benchmarkCase || ""))
    .map(group => ({ approach: group.approach, benchmarkCase: group.benchmarkCase, ...summarize(group.entries) })) };
}

function csvCell(value: unknown): string {
  let cell = value === undefined || value === null ? "" : String(value);
  // Quoting alone does not stop spreadsheet formulas. Protect formula-leading
  // source names, hooks, review notes, and platform notices as literal text.
  if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/gu, '""')}"`;
}

/** One row per latest platform observation; unposted exports receive one blank-platform row. */
export function measurementsCsv(entries: ExportHistoryEntry[]): string {
  const columns = ["history_id", "job_id", "source_name", "source_fingerprint", "title", "created_at", "approach", "benchmark_case",
    "verdict", "issue_reasons",
    "opening_clear", "ending_complete", "broll_reviewed", "broll_accepted", "caption_corrections", "broll_changes", "correction_seconds", "review_notes",
    "platform", "measured_at", "views", "average_watch_seconds", "completion_percent", "saves", "shares", "platform_notice"];
  const rows: unknown[][] = [columns];
  for (const entry of entries) {
    const review = entry.measurements?.review;
    const verdict = verdictSchema.safeParse(review?.verdict);
    const issues = issueReasonsSchema.safeParse(review?.issueReasons);
    const correction = measuredCorrections(entry);
    const posts = latestPosts(entry);
    for (const post of posts.length ? posts : [undefined]) rows.push([
      entry.id, entry.jobId, entry.sourceName, entry.sourceFingerprint, entry.title, entry.createdAt,
      label(review?.approach), label(review?.benchmarkCase),
      verdict.success ? verdict.data : undefined, issues.success ? issues.data.join(";") : undefined,
      typeof review?.openingClear === "boolean" ? review.openingClear : undefined,
      typeof review?.endingComplete === "boolean" ? review.endingComplete : undefined,
      whole(review?.brollReviewed) ? review.brollReviewed : undefined,
      whole(review?.brollAccepted) ? review.brollAccepted : undefined,
      correction.captions, correction.broll, correction.seconds, review?.notes,
      post?.platform, post?.measuredAt, whole(post?.views) ? post.views : undefined,
      nonnegative(post?.averageWatchSeconds, 86400) ? post.averageWatchSeconds : undefined,
      nonnegative(post?.completionPercent, 100) ? post.completionPercent : undefined,
      whole(post?.saves) ? post.saves : undefined, whole(post?.shares) ? post.shares : undefined, post?.platformNotice,
    ]);
  }
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
