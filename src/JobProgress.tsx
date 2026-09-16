import type { RenderJob } from "../shared/types";

type ProgressJob = Pick<RenderJob, "progress" | "phase" | "visualSearch" | "editorialProgress">;
const elapsed = (startedAt: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)) || 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function jobProgressLabel(job: ProgressJob): string {
  return job.visualSearch ? "Finding visuals" : job.editorialProgress
    ? job.editorialProgress.step === "propose" ? "Preparing correction" : "Checking edit"
    : `${Math.round(job.progress)}%`;
}

export default function JobProgress({ job }: { job: ProgressJob }) {
  const { visualSearch: visuals, editorialProgress: editorial } = job;
  const waiting = Boolean(visuals || editorial);
  return <>
    <div className={`job-progress${waiting ? " is-searching" : ""}`} role="progressbar"
      aria-label={visuals ? "Preparing supporting visuals" : editorial ? job.phase || "Checking edit" : "Export progress"}
      aria-valuenow={waiting ? undefined : Math.round(job.progress)}>
      <span style={waiting ? undefined : { width: `${Math.max(1, Math.min(100, job.progress))}%` }} />
    </div>
    {visuals && <p className="job-search-detail">
      Pass {visuals.pass}/{visuals.maxPasses} · {visuals.placed}/{visuals.requested} shots placed · {elapsed(visuals.startedAt)} elapsed
      <span>Visual preparation can take up to {Math.round(visuals.budgetMs / 60000)} minutes. Rendering follows.</span>
    </p>}
    {!visuals && editorial && <p className="job-search-detail">
      {editorial.attempt ? `Correction ${editorial.attempt} of 2` : "Reviewing the selected speech"} · {elapsed(editorial.startedAt)} elapsed
      <span>DeepSeek is {editorial.step === "propose" ? "preparing a small correction" : editorial.step === "verify" ? "verifying the proposed correction" : "checking the edit against the source"}. Rendering follows.</span>
      <span>This review stage has a {Math.ceil(editorial.budgetMs / 1000)}-second limit. Any unchecked issues remain flagged for review.</span>
    </p>}
  </>;
}
