import type { EditPlan } from "./types.js";
import { finishedTimeline, type FinishedIssue } from "./finished-review.js";

export interface ReviewShotTarget { kind: "visual" | "footage"; id: string }

/** Findings use the final MP4 clock; saved visuals use the clock before inserts. */
export function reviewShotTarget(plan: EditPlan, issue: FinishedIssue, sourceFps?: number): ReviewShotTarget | undefined {
  if (issue.check === "caption-speech" || !Number.isFinite(issue.start) || !Number.isFinite(issue.end) || issue.start < 0 || issue.end < issue.start) return;
  // Without the source frame rate, inserted footage cannot be mapped precisely.
  if (plan.settings.fps === "source" && plan.settings.ownFootage?.some(item => item.mode === "insert") && !(sourceFps && sourceFps > 0)) return;
  const timeline = finishedTimeline(plan.settings, plan.sourceDuration, sourceFps || 30);
  const windows = timeline.retime(plan.visuals.filter(item => item.enabled).map(item => ({ kind: "visual" as const, id: item.id, start: item.start, end: item.end })));
  const footage = timeline.retime(timeline.covers.map(item => ({ kind: "footage" as const, id: item.id, start: item.at, end: item.at + item.length })));
  let shift = 0;
  for (const item of timeline.inserts) {
    footage.push({ kind: "footage", id: item.id, start: item.at + shift, end: item.at + shift + item.length });
    shift += item.length;
  }
  const candidates = [...windows, ...footage].filter(item => issue.end === issue.start
    ? issue.start >= item.start && issue.start < item.end
    : issue.start < item.end && issue.end > item.start);
  const identities = new Set(candidates.map(item => `${item.kind}:${item.id}`));
  if (identities.size !== 1) return;
  const target = candidates.find(item => issue.start >= item.start - 0.001 && issue.end <= item.end + 0.001);
  return target ? { kind: target.kind, id: target.id } : undefined;
}
