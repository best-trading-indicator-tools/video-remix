import { useEffect, useState } from "react";
import { Check, RefreshCw, Trash2 } from "lucide-react";
import type { VideoSource } from "../shared/types";
import type { DraftHistoryResult } from "../shared/draft-history";
import { approveShortDraft, parseSourceClock, shortIsApproved, validateShortDraft, type ShortDraft } from "../shared/shorts";

type Props = {
  active: boolean; drafts: ShortDraft[]; sources: VideoSource[]; activeId?: string; selectedIds: string[]; disabled: boolean;
  onSelect: (draft: ShortDraft) => void; onSelection: (ids: string[]) => void;
  onUpdate: (id: string, patch: Partial<ShortDraft>) => void; onApprove: (ids: string[]) => void; onDelete: (id: string) => void;
};
const date = (value: string) => new Date(value).toLocaleDateString();

export default function DraftReviewQueue({ active, drafts, sources, activeId, selectedIds, disabled, onSelect, onSelection, onUpdate, onApprove, onDelete }: Props) {
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<"all" | "pending" | "approved">("all");
  const [history, setHistory] = useState<{ key: string; results: DraftHistoryResult[] }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  // Only source identity and valid intervals affect this lookup, not typing a review note.
  const request = JSON.stringify({ drafts: drafts.flatMap(draft => {
    const cuts = draft.cuts.map(cut => ({ start: parseSourceClock(cut.start), end: parseSourceClock(cut.end) }));
    const source = sources.find(source => source.id === draft.sourceId);
    if (!cuts.length || cuts.some(cut => cut.start === null || cut.end === null || cut.end <= cut.start || (source && cut.end > source.duration + 0.001))) return [];
    return [{ id: draft.id, sourceId: draft.sourceId, cuts }];
  }) });
  const sourceIdentity = JSON.stringify(sources.map(source => [source.id, source.fingerprint]));
  const key = `${request}:${sourceIdentity}:${refresh}`;
  useEffect(() => {
    if (!active || !drafts.length) return;
    const controller = new AbortController();
    setHistory(undefined); setFailure(undefined);
    const timer = window.setTimeout(() => {
      void fetch("/api/shorts/review-history", { method: "POST", headers: { "Content-Type": "application/json" }, body: request, signal: controller.signal })
        .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error || "History could not be checked."); return body as { drafts: DraftHistoryResult[] }; })
        .then(body => { if (!controller.signal.aborted) setHistory({ key, results: body.drafts }); })
        .catch(error => { if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : "History could not be checked." }); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, key, request, drafts.length]);

  const selectedValid = drafts.filter(draft => selectedIds.includes(draft.id) && !shortIsApproved(draft) &&
    !validateShortDraft({ ...draft, autoFocus: false }, sources.find(source => source.id === draft.sourceId)).errors.length);
  return <div className="draft-review-queue">
    <p className="shorts-helper">Review each outline, then approve the drafts you want to render. Changes to a draft require approval again.</p>
    <div className="draft-review-toolbar">
      <button type="button" className="text-button" disabled={disabled} onClick={() => onSelection(selectedIds.length === drafts.length ? [] : drafts.map(item => item.id))}>{selectedIds.length === drafts.length ? "Clear selection" : "Select all shorts"}</button>
      <button type="button" className="secondary-button" disabled={disabled || !selectedValid.length} onClick={() => onApprove(selectedValid.map(item => item.id))}><Check size={14} />Approve selected ({selectedValid.length})</button>
      <button type="button" className="text-button" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} />Refresh history</button>
      <label>Show drafts<select aria-label="Draft review filter" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
        <option value="all">All ({drafts.length})</option><option value="pending">Needs review ({drafts.filter(item => !shortIsApproved(item)).length})</option><option value="approved">Approved ({drafts.filter(shortIsApproved).length})</option>
      </select></label>
    </div>
    <div className="shorts-draft-list">{drafts.filter(draft => filter === "all" || shortIsApproved(draft) === (filter === "approved")).map(draft => {
      const source = sources.find(source => source.id === draft.sourceId);
      const validation = validateShortDraft({ ...draft, autoFocus: false }, source);
      const approved = shortIsApproved(draft);
      const result = history?.key === key ? history.results.find(item => item.id === draft.id) : undefined;
      const historyError = failure?.key === key ? failure.message : undefined;
      const note = (field: "summary" | "contribution", value: string) => onUpdate(draft.id, { review: { ...draft.review, summary: draft.review?.summary || "", contribution: draft.review?.contribution || "", [field]: value } });
      return <article key={draft.id} className={`draft-review-card ${draft.id === activeId ? "active" : ""}`} aria-label={`Review ${draft.title || "Untitled short"}`}>
        <div className="draft-review-heading">
          <label className="shorts-select-check"><span className="visually-hidden">Select {draft.title || "Untitled short"}</span><input type="checkbox" disabled={disabled} checked={selectedIds.includes(draft.id)} onChange={event => onSelection(event.target.checked ? [...selectedIds, draft.id] : selectedIds.filter(id => id !== draft.id))} /></label>
          <button type="button" className="shorts-draft-main" onClick={() => onSelect(draft)}><strong>{draft.title || "Untitled short"}</strong><span>{draft.sourceName}</span></button>
          <span className={`draft-review-badge ${approved ? "approved" : ""}`}>{approved ? "Approved" : "Needs review"}</span>
          <button type="button" className="icon-button" disabled={disabled} aria-label={`Delete ${draft.title || "untitled short"} draft`} onClick={() => onDelete(draft.id)}><Trash2 size={15} /></button>
        </div>
        <div className="draft-review-notes">
          <label>Summary<textarea rows={2} maxLength={600} disabled={disabled} value={draft.review?.summary || ""} placeholder="What is the distinct idea in this clip?" onChange={event => note("summary", event.target.value)} /></label>
          <label>Added contribution (optional)<textarea rows={2} maxLength={600} disabled={disabled} value={draft.review?.contribution || ""} placeholder="Your commentary, example, or new angle" onChange={event => note("contribution", event.target.value)} /></label>
        </div>
        <p className="draft-review-note">Review notes only; these fields do not add narration or text to the video.</p>
        <details className="draft-review-context"><summary>Source timestamps · {draft.cuts.length} sequence{draft.cuts.length === 1 ? "" : "s"} · {validation.duration.toFixed(1)}s</summary>
          <ol>{draft.cuts.map((cut, index) => <li key={cut.id}><span>{cut.start} → {cut.end}</span>{source && parseSourceClock(cut.start) !== null && <a href={`${source.url}#t=${parseSourceClock(cut.start)},${parseSourceClock(cut.end) ?? ""}`} target="_blank" rel="noreferrer">Preview sequence {index + 1}</a>}</li>)}</ol>
        </details>
        <div className="draft-review-history" aria-live="polite"><strong>Previous exports &amp; publications</strong>
          {historyError ? <p className="shorts-error">{historyError} Use Refresh history to retry.</p> : !result ? <p>{validation.errors.length ? "Complete valid source timestamps to check history." : "Checking workspace history…"}</p>
            : result.status !== "checked" ? <p>History unavailable. {result.status === "source-unavailable" ? "Reconnect the source to check matches." : "This source has no saved content identity."}</p>
            : !result.matches.length ? <p>No overlapping exports recorded in this workspace.</p>
            : <ul>{result.matches.map(match => <li key={match.id}><strong>{match.title}</strong><span>{Math.round(match.draftCoverage * 100)}% of source selection used · {match.overlapSeconds.toFixed(1)}s overlap</span>
              {match.publications.length ? match.publications.map((publication, i) => <span key={i}>Published on {publication.platform}{publication.account ? ` · ${publication.account}` : ""} · {date(publication.publishedAt)}</span>) : <span>Exported {date(match.createdAt)} · no publication recorded</span>}</li>)}{result.total > result.matches.length && <li>{result.total - result.matches.length} more matching exports in History.</li>}</ul>}
          <small>Matches use this source’s timestamps and saved publication records. Posts outside this workspace are unknown.</small>
        </div>
        <div className="draft-review-footer"><button type="button" className="secondary-button" disabled={disabled} onClick={() => onSelect(draft)}>Edit outline &amp; framing</button>
          <button type="button" className={approved ? "text-button" : "secondary-button"} disabled={disabled || (!approved && !!validation.errors.length)} onClick={() => onUpdate(draft.id, { review: approved ? { summary: draft.review?.summary || "", contribution: draft.review?.contribution || "" } : approveShortDraft(draft).review })}>{approved ? "Revoke approval" : <><Check size={14} />Approve draft</>}</button></div>
        {!!validation.errors.length && <p className="shorts-error">{validation.errors[0]}</p>}
      </article>;
    })}</div>
  </div>;
}
