import { useEffect, useMemo, useState, type FormEvent } from "react";
import EditorialReportSummary from "./EditorialReportSummary";
import { ArrowLeft, CalendarDays, Check, Clock3, Download, ExternalLink, Film, LoaderCircle, Plus, RefreshCw, Search, X } from "lucide-react";
import type { ExportHistoryEntry, ExportMeasurements, ExportReview, PostMetrics, VideoSource } from "../shared/types";
import "./history.css";

type Publication = ExportHistoryEntry["publications"][number];
const platformName = (platform: Publication["platform"]) => platform === "instagram" ? "Instagram" : "TikTok";
const dateText = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const timeText = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
const localDateTime = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || "History could not be updated. Please try again.");
  return result as T;
}

type ReviewDraft = { [Key in keyof Omit<Required<ExportReview>, "issueReasons">]: string } & { issueReasons: NonNullable<ExportReview["issueReasons"]> };
type PostDraft = { [Key in keyof Required<PostMetrics>]: string };
const verdictLabels = {
  "accepted-unchanged": "Accepted unchanged",
  "accepted-after-correction": "Accepted after correction",
  rejected: "Rejected",
} satisfies Record<NonNullable<ExportReview["verdict"]>, string>;
const issueLabels = {
  opening: "Opening lacks context", ending: "Ending is incomplete", meaning: "Meaning changed or misleading",
  hook: "Opening title or hook", captions: "Captions", framing: "Framing", broll: "B-roll relevance", other: "Other",
} satisfies Record<NonNullable<ExportReview["issueReasons"]>[number], string>;
const draftReview = (review: ExportReview = {}): ReviewDraft => ({
  verdict: review.verdict && Object.hasOwn(verdictLabels, review.verdict) ? review.verdict : "",
  issueReasons: Array.isArray(review.issueReasons) ? review.issueReasons.filter(reason => Object.hasOwn(issueLabels, reason)) : [],
  benchmarkCase: review.benchmarkCase || "", approach: review.approach || "",
  openingClear: typeof review.openingClear !== "boolean" ? "" : review.openingClear ? "yes" : "no",
  endingComplete: typeof review.endingComplete !== "boolean" ? "" : review.endingComplete ? "yes" : "no",
  brollReviewed: review.brollReviewed?.toString() ?? "", brollAccepted: review.brollAccepted?.toString() ?? "",
  captionCorrections: review.captionCorrections?.toString() ?? "", correctionSeconds: review.correctionSeconds?.toString() ?? "", notes: review.notes || "",
});
const draftPost = (): PostDraft => ({ platform: "instagram", measuredAt: localDateTime(), views: "", averageWatchSeconds: "", completionPercent: "", saves: "", shares: "", platformNotice: "" });
const optionalNumber = (value: string) => value.trim() === "" ? undefined : Number(value);
const measuredNumber = (value: number | null | undefined, unit = "") => typeof value !== "number" || !Number.isFinite(value) ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`;

function MeasurementEditor({ entry, onSaved }: { entry: ExportHistoryEntry; onSaved: (entry: ExportHistoryEntry) => void }) {
  const [review, setReview] = useState(() => draftReview(entry.measurements?.review));
  const [post, setPost] = useState(draftPost);
  const [addingPost, setAddingPost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const save = async (measurements: ExportMeasurements, message: string) => {
    if (saving) return;
    setSaving(true); setError(""); setSaved("");
    try {
      const updated = await request<ExportHistoryEntry>(`/api/history/${encodeURIComponent(entry.id)}/measurements`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(measurements),
      });
      onSaved({ ...entry, ...updated });
      setSaved(message);
      return true;
    } catch (reason) { setError((reason as Error).message); return false; }
    finally { setSaving(false); }
  };
  const saveReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const brollReviewed = optionalNumber(review.brollReviewed), brollAccepted = optionalNumber(review.brollAccepted);
    if ((brollAccepted === undefined) !== (brollReviewed === undefined) || (brollAccepted !== undefined && brollAccepted > brollReviewed!)) {
      setError("Enter both the reviewed and accepted shot counts, or leave both blank. Accepted shots cannot exceed reviewed shots."); return;
    }
    const updated: ExportReview = {
      ...(review.verdict ? { verdict: review.verdict as ExportReview["verdict"] } : {}),
      ...(review.issueReasons.length ? { issueReasons: review.issueReasons } : {}),
      ...(review.benchmarkCase.trim() ? { benchmarkCase: review.benchmarkCase.trim() } : {}),
      ...(review.approach.trim() ? { approach: review.approach.trim() } : {}),
      ...(review.openingClear ? { openingClear: review.openingClear === "yes" } : {}),
      ...(review.endingComplete ? { endingComplete: review.endingComplete === "yes" } : {}),
      brollReviewed, brollAccepted,
      captionCorrections: optionalNumber(review.captionCorrections), correctionSeconds: optionalNumber(review.correctionSeconds),
      ...(review.notes.trim() ? { notes: review.notes.trim() } : {}),
    };
    void save({ ...entry.measurements, review: updated }, "Review saved.");
  };
  const savePost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timestamp = new Date(post.measuredAt);
    if (!Number.isFinite(timestamp.getTime())) { setError("Choose when you measured these results."); return; }
    const snapshot: PostMetrics = {
      platform: post.platform as PostMetrics["platform"], measuredAt: timestamp.toISOString(),
      views: optionalNumber(post.views), averageWatchSeconds: optionalNumber(post.averageWatchSeconds), completionPercent: optionalNumber(post.completionPercent),
      saves: optionalNumber(post.saves), shares: optionalNumber(post.shares),
      ...(post.platformNotice.trim() ? { platformNotice: post.platformNotice.trim() } : {}),
    };
    if ([snapshot.views, snapshot.averageWatchSeconds, snapshot.completionPercent, snapshot.saves, snapshot.shares, snapshot.platformNotice].every((value) => value === undefined)) {
      setError("Record at least one observed result or platform notice. Leave unknown values blank."); return;
    }
    if (await save({ ...entry.measurements, posts: [...(entry.measurements?.posts || []), snapshot] }, "Platform results saved.")) { setPost(draftPost()); setAddingPost(false); }
  };
  return <details className="history-measurements" onToggle={(event) => { if (event.currentTarget.open) { setReview(draftReview(entry.measurements?.review)); setError(""); setSaved(""); } }}>
    <summary>Record review &amp; results{entry.measurements?.review?.verdict && <span>{verdictLabels[entry.measurements.review.verdict]}</span>}{entry.measurements?.review?.approach && <span>{entry.measurements.review.approach}</span>}</summary>
    <p className="measurement-note">Use the same benchmark case for comparable footage and an approach name for the editing idea. Leave unknown results blank.</p>
    {entry.corrections && <p className="measurement-auto-counts">Saved revision: {entry.corrections.captionCorrections} caption corrections · {entry.corrections.brollChanges} B-roll changes{entry.corrections.seconds !== undefined ? ` · ${entry.corrections.seconds}s active correction time` : ""}</p>}
    <form onSubmit={saveReview}>
      <fieldset disabled={saving}><legend>Editorial review</legend>
        <div className="measurement-fields">
          <label className="measurement-wide">Whole-short verdict
            <select value={review.verdict} onChange={(event) => setReview({ ...review, verdict: event.target.value })}>
              <option value="">Not decided</option>
              {Object.entries(verdictLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <span>Judge the whole short after watching it. You can accept an unchanged export here without making a revision. Leave undecided work as “Not decided”.</span>
          </label>
          <fieldset className="measurement-wide measurement-issues"><legend>Issues found <span>(optional)</span></legend>
            <div>{Object.entries(issueLabels).map(([value, label]) => {
              const reason = value as NonNullable<ExportReview["issueReasons"]>[number];
              return <label key={reason}><input type="checkbox" checked={review.issueReasons.includes(reason)} onChange={(event) => setReview({ ...review,
                issueReasons: event.target.checked ? [...review.issueReasons, reason] : review.issueReasons.filter(item => item !== reason),
              })} />{label}</label>;
            })}</div>
          </fieldset>
          <label>Benchmark case<input type="text" maxLength={80} placeholder="E.g. talking head, 45 seconds" value={review.benchmarkCase} onChange={(event) => setReview({ ...review, benchmarkCase: event.target.value })} /></label>
          <label>Editorial approach<input type="text" maxLength={80} placeholder="E.g. problem → example → takeaway" value={review.approach} onChange={(event) => setReview({ ...review, approach: event.target.value })} /></label>
          <label>Opening makes sense<select value={review.openingClear} onChange={(event) => setReview({ ...review, openingClear: event.target.value })}><option value="">Not reviewed</option><option value="yes">Yes</option><option value="no">No</option></select></label>
          <label>Ending is complete<select value={review.endingComplete} onChange={(event) => setReview({ ...review, endingComplete: event.target.value })}><option value="">Not reviewed</option><option value="yes">Yes</option><option value="no">No</option></select></label>
          {([
            ["brollReviewed", "B-roll shots reviewed"], ["brollAccepted", "B-roll shots accepted"],
            ["captionCorrections", "Caption corrections"], ["correctionSeconds", "Correction time (seconds)"],
          ] as const).map(([field, label]) => <label key={field}>{label}<input type="number" min={0} max={field === "correctionSeconds" ? 86400 : 100000} step={field === "correctionSeconds" ? "any" : 1} placeholder="Not recorded" value={review[field]} onChange={(event) => setReview({ ...review, [field]: event.target.value })} /></label>)}
          <label className="measurement-wide">Review notes<textarea rows={2} maxLength={500} value={review.notes} placeholder="What worked, what needed correction, or what you want to test next" onChange={(event) => setReview({ ...review, notes: event.target.value })} /></label>
        </div>
        <p className="measurement-note">Leave correction fields blank to use the saved revision measurements. If no time was recorded, it stays unknown; enter 0 only when no correction time was needed.</p>
        <div className="history-form-actions"><button type="submit" className="secondary-button">{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save review</button></div>
      </fieldset>
    </form>
    <div className="measurement-posts"><h4>Results recorded after posting</h4>
      <p className="measurement-note">Track one post per platform for this export. Later observations update that same post's results in comparisons.</p>
      {(entry.measurements?.posts || []).map((snapshot, index) => <div className="measurement-snapshot" key={`${snapshot.platform}-${snapshot.measuredAt}-${index}`}>
        <div><strong>{platformName(snapshot.platform)}</strong><span>Measured {dateText(snapshot.measuredAt)}</span>
          <p>Views {measuredNumber(snapshot.views)} · Average watch {measuredNumber(snapshot.averageWatchSeconds, "s")} · Completion {measuredNumber(snapshot.completionPercent, "%")} · Saves {measuredNumber(snapshot.saves)} · Shares {measuredNumber(snapshot.shares)}</p>
          {snapshot.platformNotice && <p className="measurement-notice">Platform notice: {snapshot.platformNotice}</p>}
        </div><button type="button" className="icon-button" aria-label={`Remove ${platformName(snapshot.platform)} result snapshot`} disabled={saving} onClick={() => void save({ ...entry.measurements, posts: entry.measurements?.posts?.filter((_, itemIndex) => itemIndex !== index) }, "Result snapshot removed.")}><X size={14} /></button>
      </div>)}
      {!entry.measurements?.posts?.length && <p className="measurement-note">No platform results recorded.</p>}
      {!addingPost && <button type="button" className="secondary-button measurement-add-post" disabled={saving || (entry.measurements?.posts?.length || 0) >= 20} onClick={() => { setPost(draftPost()); setAddingPost(true); setError(""); setSaved(""); }}><Plus size={14} />Add platform results</button>}
      {(entry.measurements?.posts?.length || 0) >= 20 && <p className="measurement-note">20 observations are saved. Remove an earlier snapshot before adding another.</p>}
      {addingPost && <form className="measurement-post-form" onSubmit={(event) => void savePost(event)}><fieldset disabled={saving}><legend>New results snapshot</legend>
        <div className="measurement-fields">
          <label>Results platform<select value={post.platform} onChange={(event) => setPost({ ...post, platform: event.target.value })}><option value="instagram">Instagram</option><option value="tiktok">TikTok</option></select></label>
          <label>Measured date and time<input type="datetime-local" required value={post.measuredAt} onChange={(event) => setPost({ ...post, measuredAt: event.target.value })} /></label>
          {([
            ["views", "Views"], ["averageWatchSeconds", "Average watch time (seconds)"], ["completionPercent", "Completion (%)"], ["saves", "Saves"], ["shares", "Shares"],
          ] as const).map(([field, label]) => <label key={field}>{label}<input type="number" min={0} max={field === "completionPercent" ? 100 : field === "averageWatchSeconds" ? 86400 : 1_000_000_000_000} step={field === "completionPercent" || field === "averageWatchSeconds" ? "any" : 1} placeholder="Not recorded" value={post[field]} onChange={(event) => setPost({ ...post, [field]: event.target.value })} /></label>)}
          <label className="measurement-wide">Actual platform notice <span>(optional)</span><textarea rows={2} maxLength={500} value={post.platformNotice} placeholder="Copy or summarize a notice you actually received" onChange={(event) => setPost({ ...post, platformNotice: event.target.value })} /></label>
        </div><div className="history-form-actions"><button type="button" className="secondary-button" onClick={() => setAddingPost(false)}>Cancel</button><button type="submit" className="secondary-button">{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save platform results</button></div>
      </fieldset></form>}
    </div>
    {error && <p className="history-error" role="alert">{error}</p>}{saved && <p className="measurement-saved" role="status">{saved}</p>}
  </details>;
}

interface MeasurementGroup {
  approach: string | null; benchmarkCase: string | null; exports: number; reviewedExports: number;
  verdictReviews: number; unknownAcceptanceExports: number; acceptedUnchanged: number; acceptedAfterCorrection: number; rejected: number;
  acceptanceRate: number | null; unchangedAcceptanceRate: number | null;
  openingReviews: number; openingClear: number; endingReviews: number; endingComplete: number;
  brollReviewExports: number; brollReviewed: number; brollAccepted: number; brollAcceptanceRate: number | null;
  captionMeasuredExports: number; captionCorrections: number | null;
  correctionTimeExports: number; averageCorrectionSeconds: number | null; medianCorrectionSeconds: number | null;
}
function MeasurementComparison({ groups, entries }: { groups: MeasurementGroup[] | null; entries: ExportHistoryEntry[] }) {
  const latest = entries.flatMap((entry) => (["instagram", "tiktok"] as const).flatMap((platform) => {
    const snapshot = entry.measurements?.posts?.filter((post) => post?.platform === platform && Number.isFinite(Date.parse(post.measuredAt))).reduce<PostMetrics | undefined>((latest, post) =>
      !latest || Date.parse(post.measuredAt) >= Date.parse(latest.measuredAt) ? post : latest, undefined);
    return snapshot ? [{ entry, snapshot }] : [];
  }));
  return <details className="measurement-comparison">
    <summary>Compare recorded results</summary>
    <p className="measurement-note">All recorded reviews, grouped by editorial approach and benchmark case. Acceptance rates use only explicit whole-short verdicts, including rejections. Undecided exports stay outside that denominator. Each export is counted separately, including revisions.</p>
    <div className="measurement-downloads"><a className="secondary-button" href="/api/measurements/export?format=csv" download><Download size={13} />Download all measurements · CSV</a><a className="secondary-button" href="/api/measurements/export?format=json" download><Download size={13} />JSON</a></div>
    {groups?.length ? <><p className="measurement-table-hint">Swipe to compare →</p><div className="measurement-table-scroll" tabIndex={0} role="region" aria-label="Editorial approach comparison"><table className="measurement-table"><thead><tr><th>Approach / case</th><th>Whole-short verdicts</th><th>Accepted unchanged</th><th>Accepted overall</th><th>Exports reviewed</th><th>B-roll accepted / reviewed</th><th>Clear openings</th><th>Complete endings</th><th>Caption corrections</th><th>Median correction time</th></tr></thead><tbody>
      {groups.map((group, index) => <tr key={`${group.approach}-${group.benchmarkCase}-${index}`}>
        <th>{group.approach || "Approach not recorded"}<small>{group.benchmarkCase || "Case not recorded"}</small></th>
        <td>{group.verdictReviews} / {group.exports}<small>{group.unknownAcceptanceExports} undecided</small></td>
        <td>{group.unchangedAcceptanceRate === null ? "—" : `${group.acceptedUnchanged} / ${group.verdictReviews} (${Math.round(group.unchangedAcceptanceRate * 100)}%)`}</td>
        <td>{group.acceptanceRate === null ? "—" : `${group.acceptedUnchanged + group.acceptedAfterCorrection} / ${group.verdictReviews} (${Math.round(group.acceptanceRate * 100)}%)`}<small>{group.acceptedAfterCorrection} after correction · {group.rejected} rejected</small></td>
        <td>{group.reviewedExports} / {group.exports}</td>
        <td>{group.brollReviewExports ? `${group.brollAccepted} / ${group.brollReviewed}${group.brollAcceptanceRate === null ? "" : ` (${Math.round(group.brollAcceptanceRate * 100)}%)`}` : "—"}</td>
        <td>{group.openingReviews ? `${group.openingClear} / ${group.openingReviews}` : "—"}</td><td>{group.endingReviews ? `${group.endingComplete} / ${group.endingReviews}` : "—"}</td>
        <td>{group.captionMeasuredExports === 0 || group.captionCorrections === null ? "—" : group.captionCorrections}<small>{group.captionMeasuredExports} exports measured</small></td>
        <td>{measuredNumber(group.medianCorrectionSeconds, "s")}<small>{group.correctionTimeExports} exports timed · Average {measuredNumber(group.averageCorrectionSeconds, "s")}</small></td>
      </tr>)}
    </tbody></table></div></> : <p className="measurement-note">{groups === null ? "Comparison data is not available yet." : "Record reviews on the exports below to start comparing approaches."}</p>}
    {!!latest.length && <><h3>Latest platform results for listed exports</h3><p className="measurement-note">One latest snapshot per export and platform. Compare similar cases measured after similar amounts of time.</p><p className="measurement-table-hint">Swipe to compare →</p><div className="measurement-table-scroll" tabIndex={0} role="region" aria-label="Latest platform results"><table className="measurement-table"><thead><tr><th>Export / approach</th><th>Platform / measured</th><th>Views</th><th>Average watch</th><th>Completion</th><th>Saves</th><th>Shares</th><th>Platform notice</th></tr></thead><tbody>{latest.map(({ entry, snapshot }) => <tr key={`${entry.id}-${snapshot.platform}`}><th>{entry.title || entry.sourceName}<small>{entry.measurements?.review?.approach || "Approach not recorded"} · {entry.measurements?.review?.benchmarkCase || "Case not recorded"}</small></th><td>{platformName(snapshot.platform)}<small>{dateText(snapshot.measuredAt)}</small></td><td>{measuredNumber(snapshot.views)}</td><td>{measuredNumber(snapshot.averageWatchSeconds, "s")}</td><td>{measuredNumber(snapshot.completionPercent, "%")}</td><td>{measuredNumber(snapshot.saves)}</td><td>{measuredNumber(snapshot.shares)}</td><td>{snapshot.platformNotice || "—"}</td></tr>)}</tbody></table></div></>}
  </details>;
}

function HistoryCard({ entry, stockUses, onSaved }: {
  entry: ExportHistoryEntry;
  stockUses: Map<string, number>;
  onSaved: (entry: ExportHistoryEntry) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState<Publication["platform"]>("instagram");
  const [publishedAt, setPublishedAt] = useState(localDateTime);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (publications: Publication[]) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const updated = await request<ExportHistoryEntry>(`/api/history/${encodeURIComponent(entry.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publications }),
      });
      onSaved({ ...entry, ...updated });
      setAdding(false);
      setUrl("");
    } catch (reason) { setError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const addPublication = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const date = new Date(publishedAt);
    if (!Number.isFinite(date.getTime())) { setError("Choose the date and time you published this video."); return; }
    const trimmedUrl = url.trim();
    if (trimmedUrl) {
      try {
        const parsed = new URL(trimmedUrl);
        const domain = platform === "instagram" ? "instagram.com" : "tiktok.com";
        if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          !(parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) throw new Error("Invalid publication URL");
      } catch { setError(`Use an HTTPS link to your ${platformName(platform)} post, or leave the link blank.`); return; }
    }
    void save([...entry.publications, { platform, publishedAt: date.toISOString(), ...(trimmedUrl ? { url: trimmedUrl } : {}) }]);
  };
  return <article className="history-card" aria-label={`History for ${entry.title || entry.sourceName}`}>
    <div className="history-card-top">
      <div className="history-card-title"><span className="history-entry-icon"><Film size={20} /></span>
        <div><h3>{entry.title || entry.sourceName}</h3><p>{entry.sourceName}</p></div>
      </div>
      <span className={`history-status ${entry.publications.length ? "published" : ""}`}>
        {entry.publications.length ? <Check size={13} /> : <Clock3 size={13} />}{entry.publications.length ? "Published" : "Exported"}
      </span>
    </div>
    <div className="history-entry-meta"><span>Exported {dateText(entry.createdAt)}</span><span>{timeText(entry.outputDuration)} video</span>{entry.parentJobId && <span>Revision {entry.revision}</span>}</div>
    <details className="history-excerpts">
      <summary>Source excerpts &amp; stock footage</summary>
      <p className="history-detail-label">Intervals used from the original source</p>
      <ul className="history-intervals">{entry.cuts.map((cut, index) => <li key={index}>{timeText(cut.start)}–{timeText(cut.end)}</li>)}</ul>
      {entry.sourceText && <p className="history-source-text">{entry.sourceText}</p>}
      {!!entry.stockShots.length && <><p className="history-detail-label">Stock clips used</p><ul className="history-stock-list">{entry.stockShots.map((shot, index) => <li key={`${shot.identity}-${index}`}>
        <span>{shot.name}</span><small>{timeText(shot.sourceStart)}–{timeText(shot.sourceStart + shot.duration)}{(stockUses.get(shot.identity) || 0) > 1 ? ` · Used in ${stockUses.get(shot.identity)} listed exports` : ""}</small>
      </li>)}</ul></>}
    </details>
    <EditorialReportSummary report={entry.editorialReport} compact />
    <MeasurementEditor entry={entry} onSaved={onSaved} />
    <div className="history-publications" aria-label="Recorded publications">
      {entry.publications.map((publication, index) => <div className="history-publication" key={`${publication.platform}-${publication.publishedAt}-${index}`}>
        <CalendarDays size={14} /><div><strong>{platformName(publication.platform)}</strong><span>{dateText(publication.publishedAt)}</span></div>
        {publication.url && <a href={publication.url} target="_blank" rel="noreferrer" aria-label={`View ${platformName(publication.platform)} post`}><ExternalLink size={15} /></a>}
        <button type="button" className="icon-button" disabled={saving} aria-label={`Remove ${platformName(publication.platform)} publication record`} title="Remove publication record" onClick={() => void save(entry.publications.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
      </div>)}
    </div>
    {adding && <form className="history-publication-form" onSubmit={addPublication}>
      <p>Record a post you published.</p>
      <fieldset disabled={saving}><legend className="visually-hidden">Publication details</legend>
        <div className="history-publication-fields">
          <label>Platform<select value={platform} onChange={(event) => setPlatform(event.target.value as Publication["platform"])}><option value="instagram">Instagram</option><option value="tiktok">TikTok</option></select></label>
          <label>Published date and time<input type="datetime-local" required value={publishedAt} onChange={(event) => setPublishedAt(event.target.value)} /></label>
          <label className="history-publication-url">Post link <span>(optional)</span><input type="url" value={url} placeholder={platform === "instagram" ? "https://www.instagram.com/reel/…" : "https://www.tiktok.com/@…/video/…"} onChange={(event) => setUrl(event.target.value)} /></label>
        </div>
        <div className="history-form-actions"><button type="button" className="secondary-button" onClick={() => { setAdding(false); setError(""); }}>Cancel</button><button className="secondary-button" type="submit">{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save publication record</button></div>
      </fieldset>
    </form>}
    {error && <p className="history-error" role="alert">{error}</p>}
    <div className="history-card-actions">
      <span className={`history-availability ${entry.available ? "available" : ""}`}>{entry.available ? "Export file available" : "Export file expired or removed · History kept"}</span>
      <div>{!adding && <button type="button" className="secondary-button" disabled={saving} onClick={() => { setAdding(true); setError(""); }}><Plus size={13} />Record publication</button>}
        {entry.available && <>
          <a className="secondary-button" href={`/api/jobs/${encodeURIComponent(entry.jobId)}/video`} target="_blank" rel="noreferrer"><ExternalLink size={13} />Preview</a>
          <a className="secondary-button" href={`/api/jobs/${encodeURIComponent(entry.jobId)}/download`} download><Download size={13} />MP4</a>
        </>}
      </div>
    </div>
  </article>;
}

export default function HistoryPanel({ source, refreshKey, onClearSource, onBack }: {
  source: VideoSource | null;
  refreshKey: string;
  onClearSource: () => void;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<ExportHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [measurementGroups, setMeasurementGroups] = useState<MeasurementGroup[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const endpoint = source ? `/api/sources/${encodeURIComponent(source.id)}/history` : "/api/history";
    void request<{ entries: ExportHistoryEntry[] }>(endpoint, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setEntries(result.entries); })
      .catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source?.id, refreshKey, reload]);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ groups: MeasurementGroup[] }>("/api/measurements", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setMeasurementGroups(result.groups); })
      .catch(() => { if (!controller.signal.aborted) setMeasurementGroups(null); });
    return () => controller.abort();
  }, [refreshKey, reload]);
  const stockUses = useMemo(() => {
    const uses = new Map<string, number>();
    for (const entry of entries) for (const identity of new Set(entry.stockShots.map((shot) => shot.identity))) uses.set(identity, (uses.get(identity) || 0) + 1);
    return uses;
  }, [entries]);
  const query = search.trim().toLocaleLowerCase();
  const visible = entries.filter((entry) => `${entry.title} ${entry.sourceName}`.toLocaleLowerCase().includes(query));
  return <section className="history-panel panel" aria-labelledby="history-title">
    <header className="history-heading"><div><h2 id="history-title">Export history <span className="count-pill">{entries.length}</span></h2><p>History stays available after video files expire. Review earlier excerpts and keep a record of your posts.</p></div>
      <button className="secondary-button" onClick={onBack}><ArrowLeft size={14} />Workspace</button>
    </header>
    {source && <div className="history-source-filter"><div><strong>Earlier exports from this source</strong><span>{source.name}</span></div><button className="secondary-button" onClick={onClearSource}><X size={13} />Show all history</button></div>}
    <div className="history-toolbar"><label className="history-search"><Search size={16} /><span className="visually-hidden">Search history by title or source</span><input type="search" placeholder="Search by title or source…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <button className="secondary-button" disabled={loading} onClick={() => setReload((value) => value + 1)}><RefreshCw className={loading ? "spin" : ""} size={14} />Refresh</button></div>
    <MeasurementComparison groups={measurementGroups} entries={visible} />
    {error && <p className="history-error" role="alert">{error}</p>}
    {loading && !entries.length ? <div className="history-empty" role="status"><LoaderCircle className="spin" size={24} /><p>Loading export history…</p></div> :
      !visible.length ? <div className="history-empty"><Clock3 size={30} /><h3>{query ? "No matching exports" : "Your export history starts here"}</h3><p>{query ? "Try another title or source name." : "Finished Auto edits will appear here, including future revisions."}</p></div> :
        <div className="history-list" aria-busy={loading}>{visible.map((entry) => <HistoryCard key={entry.id} entry={entry} stockUses={stockUses} onSaved={(updated) => {
          setEntries((current) => current.map((item) => item.id === updated.id ? updated : item));
          setReload((value) => value + 1);
        }} />)}</div>}
  </section>;
}
