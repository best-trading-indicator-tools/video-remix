import type { RenderJob, VideoSource } from "./types.js";
export interface WorkTiming { stage: "upscale" | "render"; samples: { at: number; progress: number }[] }
export interface ProcessingTiming {
  startedAt?: number;
  profile: string;
  outputSeconds: number;
  sourceSeconds: number;
  elapsedMs?: number;
  waitingMs?: number;
  waitingAt?: number;
  work?: WorkTiming;
  device?: string;
}
export interface TimeEstimate { low: number; high: number; basis: "speed" | "history" }
export function timingProfile(job: Pick<RenderJob, "settings" | "auto">, source: Pick<VideoSource, "width" | "height" | "fps" | "duration">, machine: string): ProcessingTiming {
  const s = job.settings, a = job.auto;
  const seconds = a ? (a.durationMode === "full" ? source.duration : Math.min(source.duration, a.targetDuration)) : (s.segments?.reduce((sum, cut) => sum + cut.end - cut.start, 0) ?? Math.max(0, Math.min(s.trimEnd ?? source.duration, source.duration) - s.trimStart)) / s.speed;
  const settings = a || s;
  return { profile: JSON.stringify(["timing-v1", machine, !!a, Math.round(source.width / 320), Math.round(source.height / 180), Math.round(source.fps / 10),
    settings.upscale || "off", settings.aspect, a ? "auto" : s.resolution, s.fps, s.device,
    !!settings.watermarkRemoval, !!s.qualityCleanup, s.automaticCaptions, a?.captions, a?.narration,
    a?.editorialMode, settings.supportingVisuals, settings.visualSources, settings.brollCount, a?.finishedReview, !!settings.ownFootage?.length]), outputSeconds: Math.max(1, seconds), sourceSeconds: source.duration };
}
/** Device status is repeated with every frame; only a real fallback resets speed. */
export function observePhase(timing: ProcessingTiming, phase: string, now = Date.now()) {
  const device = /Apple GPU|NVIDIA GPU|CPU/.exec(phase)?.[0];
  if (device) {
    if (timing.device && timing.device !== device) delete timing.work;
    timing.device = device;
  }
  if (/Waiting for the local AI upscaler/.test(phase)) { delete timing.work; timing.waitingAt ??= now; }
}
/** Raw frame/encode progress only; weighted UI percentages are never used as a clock. */
export function observeWork(timing: ProcessingTiming, stage: WorkTiming["stage"], progress: number, now = Date.now()) {
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) return;
  if (timing.waitingAt !== undefined) { timing.waitingMs = (timing.waitingMs || 0) + Math.max(0, now - timing.waitingAt); delete timing.waitingAt; }
  let work = timing.work;
  if (!work || work.stage !== stage || progress < (work.samples.at(-1)?.progress ?? 0)) work = timing.work = { stage, samples: [] };
  const last = work.samples.at(-1);
  if (last && progress === last.progress) return;
  work.samples.push({ at: now, progress });
  // Keep a recent window, including one point before its boundary.
  while (work.samples.length > 2 && work.samples[1].at < now - 60_000) work.samples.shift();
  if (work.samples.length > 120) work.samples.splice(1, work.samples.length - 120);
}
export function stageEstimate(timing?: ProcessingTiming, now = Date.now()): TimeEstimate | undefined {
  const points = timing?.work?.samples, first = points?.[0], last = points?.at(-1);
  if (!first || !last || last.progress >= 99.9 || now - last.at > 20_000 || last.at - first.at < 8000 || last.progress - first.progress < 0.5) return;
  const remaining = (100 - last.progress) * (last.at - first.at) / (last.progress - first.progress) / 1000;
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  return { low: Math.max(1, remaining * 0.8), high: remaining * 1.4 + (now - last.at) / 1000, basis: "speed" };
}
export function jobEstimate(job: RenderJob, peers: RenderJob[], now = Date.now()): TimeEstimate | undefined {
  const timing = job.timing;
  if (!timing || !["queued", "processing"].includes(job.status)) return;
  const samples = peers.filter(peer => peer.id !== job.id && peer.status === "completed" && peer.timing?.profile === timing.profile && peer.timing.elapsedMs && !peer.retry?.count
    && (!timing.device || !peer.timing.device || timing.device === peer.timing.device)
    && peer.timing.sourceSeconds / timing.sourceSeconds >= 0.5 && peer.timing.sourceSeconds / timing.sourceSeconds <= 2
    && peer.timing.outputSeconds / timing.outputSeconds >= 0.5 && peer.timing.outputSeconds / timing.outputSeconds <= 2).sort((a, b) => (a.timing?.startedAt || 0) - (b.timing?.startedAt || 0)).slice(-12);
  if (!samples.length) return;
  const predictions = samples.map(peer => peer.timing!.elapsedMs! / 1000 * timing.outputSeconds / peer.timing!.outputSeconds).sort((a, b) => a - b);
  const median = predictions[Math.floor(predictions.length / 2)];
  const elapsed = job.status === "processing" && timing.startedAt ? Math.max(0, (now - timing.startedAt - (timing.waitingMs || 0) - (timing.waitingAt !== undefined ? now - timing.waitingAt : 0)) / 1000) : 0;
  const high = Math.max(median * 1.6, predictions.at(-1)! * 1.2) - elapsed;
  // Once an old prediction is exceeded, stop showing a stale countdown.
  if (high < 5) return;
  const stage = stageEstimate(timing, now);
  return { low: Math.max(stage?.low || 5, median * 0.65 - elapsed), high: Math.max(stage?.high || 5, high), basis: "history" };
}
export function batchEstimate(batch: RenderJob[], all: RenderJob[], concurrency = 1, now = Date.now()): TimeEstimate | undefined {
  const active = batch.filter(job => ["queued", "processing"].includes(job.status));
  // Other collections ahead of this one have unknown scheduling priority.
  if (!active.length || all.some(job => job.batchId !== batch[0].batchId && ["queued", "processing"].includes(job.status))) return;
  const estimates = active.map(job => jobEstimate(job, all, now));
  if (estimates.some(value => !value)) return;
  const values = estimates as TimeEstimate[];
  const retryWait = Math.max(0, ...active.map(job => (Date.parse(job.retry?.nextRetryAt || "") - now) / 1000 || 0));
  // Selection and the AI upscaler can serialize: a parallel lower bound, serial upper bound.
  return { low: Math.max(...values.map(value => value.low), values.reduce((sum, value) => sum + value.low, 0) / Math.max(1, concurrency)), high: retryWait + values.reduce((sum, value) => sum + value.high, 0), basis: "history" };
}
export function timeRange(estimate: TimeEstimate) {
  if (estimate.high < 60) return "less than a minute";
  const low = Math.max(1, Math.floor(estimate.low / 60)), high = Math.max(low + 1, Math.ceil(estimate.high / 60));
  return `${low}–${high} minutes`;
}
export class BatchCompletionTracker {
  private active = new Map<string, number>();
  observe(jobs: RenderJob[], now = Date.now()) {
    const groups = new Map<string, RenderJob[]>();
    for (const job of jobs) groups.set(job.batchId, [...(groups.get(job.batchId) || []), job]);
    const complete: { id: string; body: string }[] = [];
    for (const [id, group] of groups) {
      if (group.some(job => ["queued", "processing"].includes(job.status))) {
        if (!this.active.has(id)) this.active.set(id, Math.min(now, ...group.map(job => job.timing?.startedAt || now)));
      } else if (this.active.has(id)) {
        if (now - this.active.get(id)! >= 60_000) {
          const count = (status: string) => group.filter(job => job.status === status).length;
          const details = [count("completed") && `${count("completed")} ready`, count("failed") && `${count("failed")} failed`, count("cancelled") && `${count("cancelled")} cancelled`, count("skipped") && `${count("skipped")} skipped`].filter(Boolean).join(" · ");
          complete.push({ id, body: details });
        }
        this.active.delete(id);
      }
    }
    for (const id of this.active.keys()) if (!groups.has(id)) this.active.delete(id);
    return complete;
  }
}
