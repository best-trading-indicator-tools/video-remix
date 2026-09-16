import type { ExportHistoryEntry } from "../shared/types";
import { latestPostObservations, PLATFORM_NAMES } from "../shared/publishing";

const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
const value = (item: unknown): string => typeof item === "boolean" ? item ? "On" : "Off" :
  item === null || item === undefined ? "Not set" : typeof item === "object" ? JSON.stringify(item) : String(item);

export function SettingsSnapshot({ entry }: { entry: ExportHistoryEntry }) {
  const snapshot = entry.configuration;
  return <details className="history-excerpts history-settings"><summary>Settings used for this export{snapshot && <span className="settings-profile">Profile {snapshot.profileId.slice(0, 8)}</span>}</summary>
    {!snapshot ? <p className="measurement-note">Settings were not retained for this older export. They cannot be reconstructed from its video alone.</p> : <>
      <p className="measurement-note">Saved export settings. {snapshot.actual.visualCount} supporting shots cover {snapshot.actual.visualCoveragePercent}% of the result. Captions: {snapshot.actual.captions}. Narration: {snapshot.actual.narration ? "on" : "off"}.</p>
      <dl className="settings-grid">{Object.entries(snapshot.settings).map(([key, item]) => <div key={key}><dt>{label(key)}</dt><dd>{value(item)}</dd></div>)}</dl>
      {!!snapshot.actual.ownFootage?.length && <><h4>Your footage placements</h4><ul className="history-stock-list">{snapshot.actual.ownFootage.map((item, i) => <li key={i}>{item.name}<small>{item.appendToEnd ? `Whole clip added at the end · ${item.end.toFixed(1)}s` : `${item.mode === "insert" ? "Inserted" : "Cover shot"} at ${item.at}s · Clip ${item.start}–${item.end}s`}</small></li>)}</ul></>}
      {snapshot.auto && <><h4>Auto choices</h4><dl className="settings-grid">{Object.entries(snapshot.auto).map(([key, item]) => <div key={key}><dt>{label(key)}</dt><dd>{value(item)}</dd></div>)}</dl></>}
    </>}
  </details>;
}

export function ConfigurationHistory({ entries, scope }: { entries: ExportHistoryEntry[]; scope?: string }) {
  const groups = new Map<string, { profile: string; platform: string; exports: Set<string>; unknown: number; normal: number; suspected: number; confirmed: number; resolved: number }>();
  for (const entry of entries) for (const post of latestPostObservations(entry)) {
    const profile = entry.configuration?.profileId || "Settings unavailable";
    const key = `${profile}:${post.platform}`;
    const group = groups.get(key) || { profile, platform: post.platform, exports: new Set<string>(), unknown: 0, normal: 0, suspected: 0, confirmed: 0, resolved: 0 };
    group.exports.add(entry.id); group[post.reachAssessment || "unknown"]++; groups.set(key, group);
  }
  return <details className="measurement-comparison"><summary>Settings &amp; posting outcomes{scope ? ` · ${scope}` : ""}</summary>
    <p className="measurement-note">Compare your latest assessment of each post by settings profile and platform. Profiles group editing choices, excluding the specific words, source times and media IDs. Footage, accounts and posting conditions still differ; these counts show associations, not proof that a setting caused a restriction.</p>
    {groups.size ? <div className="measurement-table-scroll" tabIndex={0} role="region" aria-label="Settings and posting outcomes"><table className="measurement-table"><thead><tr><th>Settings profile</th><th>Platform</th><th>Exports</th><th>No restriction observed</th><th>Suspected</th><th>Confirmed notice</th><th>Resolved</th><th>Not assessed</th></tr></thead><tbody>{[...groups.values()].map(group => <tr key={`${group.profile}:${group.platform}`}><th>{group.profile === "Settings unavailable" ? group.profile : group.profile.slice(0, 8)}</th><td>{PLATFORM_NAMES[group.platform as keyof typeof PLATFORM_NAMES]}</td><td>{group.exports.size}</td><td>{group.normal}</td><td>{group.suspected}</td><td>{group.confirmed}</td><td>{group.resolved}</td><td>{group.unknown}</td></tr>)}</tbody></table></div> : <p className="measurement-note">Record a publication and posting feedback on an export below to start comparing.</p>}
  </details>;
}
