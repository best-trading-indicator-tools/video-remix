import type { EditSegment, RenderJob } from "../shared/types.js";

export interface EditorialPlan {
  cuts: EditSegment[];
  /** Words from these source intervals, rather than a rewritten headline. */
  text?: string;
}

export function completedAutoSiblings(
  job: Pick<RenderJob, "id" | "batchId" | "sourceId">,
  previous: RenderJob[],
): RenderJob[] {
  return previous.filter(
    (other) =>
      other.id !== job.id &&
      other.batchId === job.batchId &&
      other.sourceId === job.sourceId &&
      other.status === "completed" &&
      !!other.auto,
  );
}

function mergedIntervals(cuts: EditSegment[]): EditSegment[] {
  const result: EditSegment[] = [];
  for (const cut of cuts
    .filter(
      (item) =>
        Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.start >= 0 &&
        item.end > item.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else result.push({ ...cut });
  }
  return result;
}

/** Intersection over union of source coverage; repeated shots count once. */
export function footageOverlap(
  left: EditSegment[],
  right: EditSegment[],
): number {
  const a = mergedIntervals(left);
  const b = mergedIntervals(right);
  const length = (cuts: EditSegment[]) =>
    cuts.reduce((total, cut) => total + cut.end - cut.start, 0);
  let overlap = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const first = a[i]!;
    const second = b[j]!;
    overlap += Math.max(
      0,
      Math.min(first.end, second.end) - Math.max(first.start, second.start),
    );
    if (first.end <= second.end) i++;
    else j++;
  }
  const union = length(a) + length(b) - overlap;
  return union > 0 ? overlap / union : 0;
}

/** Overlap relative to the shorter excerpt also catches a reused subclip. Advisory only. */
export function footageContainment(left: EditSegment[], right: EditSegment[]): number {
  const duration = (cuts: EditSegment[]) => mergedIntervals(cuts).reduce((sum, cut) => sum + cut.end - cut.start, 0);
  const a = duration(left), b = duration(right);
  const iou = footageOverlap(left, right);
  const intersection = iou * (a + b) / (1 + iou);
  return Math.min(a, b) > 0 ? intersection / Math.min(a, b) : 0;
}

const words = (text: string) =>
  text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function sameSourceIdea(left: string, right: string): boolean {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (!a.size || !b.size) return true;
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared) >= 0.65;
}

/**
 * A conservative editorial repeat check, not a platform acceptance predictor.
 * Require both nearly identical footage and repeated source language when it
 * exists. Without speech, footage is the only reliable evidence available.
 */
export function isRepeatedPlan(
  proposed: EditorialPlan,
  previous: EditorialPlan[],
): boolean {
  return previous.some(
    (other) =>
      footageOverlap(proposed.cuts, other.cuts) >= 0.8 &&
      sameSourceIdea(proposed.text || "", other.text || ""),
  );
}
