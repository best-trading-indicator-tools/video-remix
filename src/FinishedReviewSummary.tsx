import { AlertTriangle, Check, CircleHelp, Eye, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { FINISHED_CHECK_NAMES, type FinishedIssue, type FinishedReviewReport } from "../shared/finished-review";
import type { ReactNode } from "react";
import "./finished-review.css";

const clock = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
const labels = { pass: "No issues found in sampled checks", review: "Picture & sound need review", partial: "Picture & sound partly checked", unavailable: "Picture & sound check unavailable" };
export default function FinishedReviewSummary({ report, compact = false, onSeek, videoUrl, onRetry, retrying, retryError, onEditMoment, issueActions }: {
  report?: FinishedReviewReport; compact?: boolean; onSeek?: (time: number) => void; videoUrl?: string;
  onRetry?: () => void; retrying?: boolean; retryError?: string;
  onEditMoment?: (issue: FinishedIssue) => void; issueActions?: (issue: FinishedIssue) => ReactNode;
}) {
  if (!report && !onRetry) return null;
  const retry = onRetry && <div className="finished-review-actions"><button className="secondary-button" type="button" onClick={onRetry} disabled={retrying}>
    {retrying ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}{retrying ? "Reviewing picture & sound…" : report ? "Recheck picture & sound" : "Review finished picture & sound"}
  </button><span>Uses this export. No new render.</span>{retryError && <p role="alert">{retryError}</p>}</div>;
  if (!report) return <div className="finished-review empty">{retry}</div>;
  const reviewedSeconds = report.audio.windows.reduce((sum, item) => sum + item.end - item.start, 0);
  return <details className={`finished-review ${report.status}`} open={!compact && report.status !== "pass"}>
    <summary>{report.status === "pass" ? <Check size={15} /> : report.status === "review" ? <AlertTriangle size={15} /> : <CircleHelp size={15} />}<strong>{labels[report.status]}</strong></summary>
    <div className="finished-review-body">
      <p className="finished-review-scope"><Eye size={14} /><span>{report.picture.frames} export frames · {report.picture.sourceFrames} source frames · {report.picture.sampledVisualWindows}/{report.picture.totalVisualWindows} supporting shots sampled<br />{reviewedSeconds.toFixed(1)}s of {report.audio.duration.toFixed(1)}s audio transcribed · {report.audio.captionWindowsCompared} caption windows compared</span></p>
      <p>Picture checks inspect sampled moments. They can miss problems between frames and do not predict platform restrictions.</p>
      <ul className="finished-checks">{report.checks.map(check => <li key={check.name}><span className={`finished-check-state ${check.status}`}>{check.status === "pass" ? "Checked" : check.status === "review" ? "Review" : check.status === "not-applicable" ? "Not applicable" : "Unavailable"}</span><div><strong>{FINISHED_CHECK_NAMES[check.name]}</strong><p>{check.detail}</p></div></li>)}</ul>
      {!!report.issues.length && <ol className="finished-findings">{report.issues.map((issue, index) => <li key={`${issue.check}-${index}`}>
        <div className="finished-finding-title">{onSeek ? <button type="button" className="secondary-button" onClick={() => onSeek(issue.start)}><Play size={13} />{clock(issue.start)}–{clock(issue.end)}</button>
          : videoUrl ? <a className="secondary-button" target="_blank" rel="noreferrer" href={`${videoUrl}#t=${issue.start}`}><Play size={13} />{clock(issue.start)}</a> : <span>{clock(issue.start)}</span>}<strong>{issue.message}</strong></div><p>{issue.evidence}</p>
        {onEditMoment && <button type="button" className="secondary-button" onClick={() => onEditMoment(issue)}>Edit this moment</button>}
        {issueActions?.(issue)}
      </li>)}</ol>}
      {report.picture.reason && <p className="finished-review-reason">{report.picture.reason}</p>}
      {report.audio.reason && <p className="finished-review-reason">{report.audio.reason}</p>}
      {retry}
    </div>
  </details>;
}
