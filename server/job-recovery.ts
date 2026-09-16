import type { RenderJob } from "../shared/types.js";
import { config } from "./config.js";

/** Failures requiring a changed input, configuration or disk cannot heal by retrying. */
export function canRetryRender(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && ["ENOENT", "ENOSPC", "EDQUOT", "EACCES", "EPERM", "EISDIR", "ENOTDIR"].includes(code)) return false;
  const status = (error as { status?: number } | undefined)?.status;
  if (status && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/no longer available|moved or changed|import it again|attach it again|no such file|not found|permission denied|no space left|disk quota|is a directory|non-empty local file|invalid data found|invalid argument|output size limit|shorter than its selected interval|(?:api[ _-]?key|credentials?).*(?:missing|required|invalid|not configured)|(?:unauthorized|forbidden)/i.test(message);
}

export function retryPhase(job: RenderJob): string {
  const retry = job.retry!;
  return `Waiting for automatic retry ${retry.count} of ${retry.limit}`;
}

/** Called only after the old worker's files have been cleaned up. Budget survives restarts. */
export function scheduleJobRetry(job: RenderJob, reason: string, cause: "failure" | "restart", retryable = true, now = Date.now()) {
  const count = job.retry?.count ?? 0;
  const limit = job.retry?.limit ?? config.renderRetries;
  const lastPhase = job.phase;
  job.retry = { count, limit, cause, reason, lastPhase };
  if (!retryable || count >= limit) {
    job.retry.stopped = retryable ? "limit" : "needs-attention";
    job.status = "failed";
    job.error = reason;
    job.phase = undefined;
    job.finishedAt = new Date(now).toISOString();
    return;
  }
  job.retry.count++;
  job.retry.nextRetryAt = new Date(now + Math.min(300_000, config.retryDelayMs * 3 ** count)).toISOString();
  job.status = "queued";
  job.progress = 0;
  job.phase = retryPhase(job);
  delete job.error;
  delete job.finishedAt;
}

export function recoverInterruptedJob(job: RenderJob) {
  if (job.cancelledByUser) {
    job.status = "cancelled";
    job.phase = undefined;
    job.finishedAt = new Date().toISOString();
    if (job.retry) delete job.retry.nextRetryAt;
    delete job.error;
  } else scheduleJobRetry(job, "The backend stopped or restarted while this edit was processing.", "restart");
}
