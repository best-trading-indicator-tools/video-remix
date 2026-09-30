import { Component, useRef, useSyncExternalStore, type ReactNode } from "react";
import { CircleHelp, X } from "lucide-react";
import type { Diagnostic } from "../shared/diagnostics";
import { makeDiagnostic } from "../shared/diagnostics";
import { clearDiagnostics, diagnosticReport, getDiagnostics, getServerDiagnostics, recordDiagnostic, subscribeDiagnostics } from "./diagnostics-store";
import ProblemNotice, { CopyDiagnostic } from "./ProblemNotice";

export default function DiagnosticsCenter() {
  const issues = useSyncExternalStore(subscribeDiagnostics, getDiagnostics, getServerDiagnostics);
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="diagnostics-launcher" onClick={() => dialog.current?.showModal()}><CircleHelp size={16} />Help & errors{issues.length > 0 && <span>{issues.length}</span>}</button>
    <dialog ref={dialog} className="diagnostics-dialog" aria-labelledby="diagnostics-title">
      <div className="diagnostics-header"><h2 id="diagnostics-title">Help & errors</h2><button type="button" aria-label="Close help and errors" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <p>When something goes wrong, copy its details and send them to the app owner. Nothing is sent automatically.</p>
      <p className="diagnostics-retention">The latest 30 errors and warnings stay here for this browser tab, including after a refresh.</p>
      {!!issues.length && <div className="diagnostics-actions"><CopyDiagnostic diagnostic={issues[0]!} all={issues.map(diagnosticReport).join("\n\n---\n\n")} /><button type="button" onClick={clearDiagnostics}>Clear history</button></div>}
      {!issues.length ? <p className="diagnostics-empty">No errors or warnings recorded in this tab.</p> : <div className="diagnostics-list">{issues.map(issue => <section key={issue.id}>
        <p className="diagnostics-time"><time dateTime={issue.occurredAt}>{new Date(issue.occurredAt).toLocaleString()}</time> · {issue.operation}</p>
        <ProblemNotice message={issue.message} diagnostic={issue} register={false} />
      </section>)}</div>}
    </dialog>
  </>;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { issue?: Diagnostic }> {
  state: { issue?: Diagnostic } = {};
  static getDerivedStateFromError(error: Error) { return { issue: makeDiagnostic(error.message, { operation: "Display the workspace" }) }; }
  componentDidCatch() { if (this.state.issue) recordDiagnostic(this.state.issue); }
  render() {
    return this.state.issue ? <main className="app-error-fallback"><h1>The workspace could not be displayed</h1>
      <ProblemNotice message={this.state.issue.message} diagnostic={this.state.issue} />
      <button type="button" onClick={() => window.location.reload()}>Reload workspace</button>
    </main> : this.props.children;
  }
}
