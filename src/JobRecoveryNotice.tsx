import ProblemNotice from "./ProblemNotice";
import { RefreshCw } from "lucide-react";
import type { RenderJob } from "../shared/types";

export default function JobRecoveryNotice({ job }: { job: RenderJob }) {
  if (job.status === "cancelled") return <p className="job-skip-note">
    {job.cancelledByUser ? "Stopped by your Cancel action. Automatic retries are off for this edit."
      : "This older edit did not record why it was cancelled. Select Retry to start it again."}
  </p>;
  const retry = job.retry;
  if (!retry) return null;
  if (job.status === "completed") return retry.count > 0
    ? <p className="job-skip-note">Finished after {retry.count} automatic {retry.count === 1 ? "retry" : "retries"}.</p> : null;
  const title = retry.stopped === "needs-attention" ? "A change is needed before retrying"
    : retry.stopped === "limit" ? retry.limit === 0 ? "Automatic retries are disabled" : `Stopped after ${retry.count} automatic retries`
    : `Automatic retry ${retry.count} of ${retry.limit}`;
  return <div className="job-recovery" role="status">
    <div className="job-recovery-heading"><RefreshCw size={14} /><strong>{title}</strong>
      {job.status === "queued" && retry.nextRetryAt && <span>Scheduled for <time dateTime={retry.nextRetryAt}>
        {new Date(retry.nextRetryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time></span>}
    </div>
    <ProblemNotice register={false} message={retry.reason} diagnostic={job.diagnostic ? { ...job.diagnostic, severity: job.status === "failed" ? "error" : "warning" } : undefined} operation="Export video" entityId={job.id} severity={job.status === "failed" ? "error" : "warning"} />
    {retry.lastPhase && <p className="job-recovery-context">Stopped during: {retry.lastPhase}</p>}
  </div>;
}
