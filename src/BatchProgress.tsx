import { batchEstimate, stageEstimate, timeRange } from "../shared/processing-time";
import type { RenderJob } from "../shared/types";
export default function BatchProgress({ batch, jobs, concurrency }: { batch: RenderJob[]; jobs: RenderJob[]; concurrency: number }) {
  const ordered = [...batch].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.variant - b.variant);
  const running = ordered.filter(job => job.status === "processing");
  const current = running.find(job => job.timing?.work) || running[0] || ordered.find(job => job.status === "queued");
  if (!current) return null;
  const estimate = batchEstimate(batch, jobs, concurrency);
  const stage = current.status === "processing" ? stageEstimate(current.timing) : undefined;
  const done = ordered.filter(job => !["processing", "queued"].includes(job.status)).length;
  return <div className="batch-progress-summary">
    <strong>Video {ordered.indexOf(current) + 1} of {batch.length} · {current.timing?.work?.stage === "upscale" ? "AI upscaling" : current.phase || "Waiting to start"}</strong>
    <span>{done} finished{running.length > 1 ? ` · ${running.length} processing together` : ""}</span>
    {estimate ? <p>Approximately {timeRange(estimate)} remaining for this collection <small>Based on recent exports on this computer; timing can change.</small></p>
      : stage ? <p>Approximately {timeRange(stage)} left for {current.timing?.work?.stage === "upscale" ? "this upscaling stage" : "this encoding stage"}.<small>Other stages follow. Learning the collection time as videos finish.</small></p>
      : <p>{current.status === "queued" ? "Waiting for processing. " : "Measuring processing speed. "}<small>Collection estimates appear after a comparable export finishes on this computer. AI planning and searches can vary.</small></p>}
  </div>;
}
