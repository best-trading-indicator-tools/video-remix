import { useEffect, useMemo, useState } from "react";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { makeDiagnostic, type Diagnostic } from "../shared/diagnostics";
import { diagnosticReport, findDiagnostic, recordDiagnostic } from "./diagnostics-store";
import "./diagnostics.css";

export function CopyDiagnostic({ diagnostic, all }: { diagnostic: Diagnostic; all?: string }) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const report = all || diagnosticReport(diagnostic);
  useEffect(() => { setCopied(false); }, [report]);
  return <div className="diagnostic-copy">
    <button type="button" className="diagnostic-copy-button" onClick={async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(report); setCopied(true); setFallback(false);
      } catch { setFallback(true); setCopied(false); }
    }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Error details copied" : all ? "Copy recent error details" : "Copy error details"}</button>
    {fallback && <div className="diagnostic-copy-fallback"><p role="status">Clipboard access is unavailable. Select and copy this report manually.</p>
      <textarea aria-label="Error details to copy" readOnly value={report} rows={8} onFocus={event => event.currentTarget.select()} />
    </div>}
    {copied && <span className="visually-hidden" role="status">Error details copied.</span>}
  </div>;
}

export default function ProblemNotice({ message, diagnostic, operation = "Workspace action", entityId, severity = "error", className = "", register = true }: {
  message: string; diagnostic?: Diagnostic; operation?: string; entityId?: string;
  severity?: Diagnostic["severity"]; className?: string; register?: boolean;
}) {
  const issue = useMemo(() => diagnostic || findDiagnostic(message) || makeDiagnostic(message, { operation, entityId, severity }),
    [diagnostic, message, operation, entityId, severity]);
  useEffect(() => { if (register) recordDiagnostic(issue); }, [issue, register]);
  return <div className={`problem-notice ${issue.severity} ${className}`} role={issue.severity === "error" ? "alert" : "status"}>
    <div className="problem-heading"><AlertTriangle size={15} /><strong>{issue.title}</strong></div>
    <p className="problem-message">{issue.message}</p>
    <p className="problem-next-step">{issue.nextStep}</p>
    <CopyDiagnostic diagnostic={issue} />
    <details className="problem-details"><summary>Report details</summary>
      <p>Review before sharing. Local paths and common credentials are redacted. No files or request contents are attached.</p>
      <pre>{diagnosticReport(issue)}</pre>
    </details>
  </div>;
}
