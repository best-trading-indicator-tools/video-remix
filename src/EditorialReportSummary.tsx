import { AlertTriangle, Check, CircleHelp } from "lucide-react";
import type { EditorialReport } from "../shared/editorial";
import type { EditorialRepairLog } from "../shared/editorial-repair";
import "./editorial-report.css";

const names: Record<string, string> = {
  "opening-context": "Understandable opening", "ending-complete": "Complete ending",
  "hook-supported": "Accurate heading and callouts", "meaning-preserved": "Source meaning",
  "captions-supported": "Caption wording", "source-evidence": "Source transcript",
  "cut-boundaries": "Cut boundaries", "caption-timing": "Caption timing", "plan-structure": "Edit structure",
};
const clock = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
const statusLabel = (report: EditorialReport) => report.status === "pass" ? "Checks passed"
  : report.status === "unavailable" ? "Check unavailable" : "Review needed";
const attemptLabels = { accepted: "Kept after recheck", rejected: "Proposal rejected", unavailable: "Unavailable" };

/** Keep editorial findings distinct from media diagnostics and human acceptance. */
export default function EditorialReportSummary({ report: savedReport, repair, compact = false, onSeek }: {
  report?: EditorialReport; repair?: EditorialRepairLog; compact?: boolean; onSeek?: (seconds: number) => void;
}) {
  const report = savedReport;
  if (!report) return null;
  const title = report.status === "pass" ? "Editorial checks passed"
    : report.status === "unavailable" ? "Editorial check unavailable" : "Editorial review needed";
  return <details className={`editorial-report ${report.status} ${compact ? "compact" : ""}`} open={!compact && report.status !== "pass"}>
    <summary>{report.status === "pass" ? <Check size={14} /> : report.status === "unavailable" ? <CircleHelp size={14} /> : <AlertTriangle size={14} />}
      <strong>{title}</strong></summary>
    <p>Checks selected speech, headings, callouts, and captions against the original transcript. Your judgment of the finished video is recorded separately in History.</p>
    {!!report.issues.length && <ul className="editorial-issues">{report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
      <strong>{names[issue.check] || "Edit review"}: </strong>{issue.message}
      {issue.outputStart !== undefined && (onSeek
        ? <button type="button" className="editorial-seek" onClick={() => onSeek(issue.outputStart!)}>Play at {clock(issue.outputStart)}</button>
        : <span> · Output {clock(issue.outputStart)}</span>)}
      {issue.evidence.slice(0, compact ? 1 : 3).map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}>
        “{evidence.quote}” <small>Source {clock(evidence.start)}–{clock(evidence.end)}</small>
      </blockquote>)}
    </li>)}</ul>}
    {!compact && <ul className="editorial-checks">{report.checks.map((check, index) => <li key={`${check.check}-${index}`}>
      <span>{names[check.check] || check.check}</span><span>{check.status === "pass" ? "Passed" : check.status === "needs-review" ? "Review" : check.status === "not-applicable" ? "Not applicable" : "Not checked"}</span>
      {check.status !== "pass" && <small>{check.message}</small>}
    </li>)}</ul>}
    {report.coverage.semantic !== "complete" && <p className="editorial-coverage">
      {report.coverage.semantic === "partial" ? "Only part of the selected speech received a meaning check. Review the remaining context."
        : "The meaning check could not finish. Review the opening, heading, and ending yourself."}
    </p>}
    <p className="editorial-coverage">Picture content and the rendered audio are not assessed by this transcript check.</p>
    {repair && <details className="editorial-repair">
      <summary><strong>Automatic repair · {repair.attempts.length} {repair.attempts.length === 1 ? "attempt" : "attempts"}</strong></summary>
      <p>Initial: {statusLabel(repair.initialReport)}. Final: {statusLabel(repair.finalReport)}.</p>
      <p><strong>Stopped:</strong> {repair.stopReason}</p>
      <p className="editorial-coverage">These are automatic edit decisions. Human acceptance and correction time are recorded separately in History.</p>
      {repair.attempts.map((attempt, index) => <details className={`editorial-repair-attempt ${attempt.outcome}`} key={`${attempt.attempt}-${index}`}>
        <summary>Attempt {attempt.attempt} · {attemptLabels[attempt.outcome]}</summary>
        {attempt.summary && <p>{attempt.summary}</p>}
        <p>{attempt.reason}</p>
        <div className="editorial-repair-findings">
          <section><h4>Before this attempt</h4><EditorialReportSummary report={attempt.beforeReport} /></section>
          <section><h4>After this proposal</h4>{attempt.afterReport ? <EditorialReportSummary report={attempt.afterReport} />
            : <p>No completed follow-up check. The previous edit was kept.</p>}</section>
        </div>
      </details>)}
    </details>}
  </details>;
}
