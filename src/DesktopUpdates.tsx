import { useEffect, useState } from "react";
import { Download, ExternalLink, LoaderCircle, X } from "lucide-react";
import type { DesktopUpdateState } from "../shared/desktop-updates";
import "./desktop-updates.css";

function useDesktopUpdates() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const api = window.remixDesktop;
    if (!api?.getUpdateState) return;
    let active = true, received = false;
    const unsubscribe = api.onUpdateState(value => { received = true; if (active) setState(value); });
    void api.getUpdateState().then(value => { if (active && !received) setState(value); }).catch(() => {
      if (active) setError("Could not read update status. Restart Remix Studio to try again.");
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  const check = async () => {
    setError("");
    try { const result = await window.remixDesktop?.checkUpdates(); if (result) setState(result); }
    catch { setError("Could not check for updates. Try again shortly."); }
  };
  const open = async () => {
    setError("");
    try { await window.remixDesktop?.openUpdate(); }
    catch { setError("Could not open the release page. Try again."); }
  };
  return { state, error, check, open };
}

export function DesktopUpdateNotice({ hidden = false }: { hidden?: boolean }) {
  const { state, error, open } = useDesktopUpdates();
  const [dismissed, setDismissed] = useState("");
  if (hidden || !state?.release || state.release.version === dismissed) return null;
  return <aside className="desktop-update-notice" aria-label="App update">
    <Download size={18} aria-hidden="true" />
    <div><strong>Remix Studio {state.release.version} is available</strong>
      <p>Update when you’re ready. Your workspace and downloaded models stay on this computer.</p>
      {error && <p role="alert">{error}</p>}</div>
    <button type="button" className="secondary-button" onClick={() => void open()}>View update <ExternalLink size={14} aria-hidden="true" /></button>
    <button type="button" className="update-dismiss" aria-label="Remind me next time" title="Remind me next time" onClick={() => setDismissed(state.release!.version)}><X size={16} /></button>
  </aside>;
}

export function DesktopUpdateSettings() {
  const { state, error, check, open } = useDesktopUpdates();
  if (!window.remixDesktop?.getUpdateState) return null;
  return <section className="desktop-update-settings panel" aria-label="App updates">
    <div><h2>App updates</h2><p>{state ? `Installed version: ${state.currentVersion}` : "Reading installed version…"}</p>
      <p>Feature releases are checked automatically. Small improvements arrive together in the next release.</p></div>
    <div className="desktop-update-actions">
      <button type="button" className="secondary-button" disabled={!state || state.status === "checking"} onClick={() => void check()}>
        {state?.status === "checking" ? <><LoaderCircle size={14} className="spin" />Checking…</> : "Check for updates"}</button>
      {state?.release && <button type="button" className="secondary-button" onClick={() => void open()}>View update <ExternalLink size={14} aria-hidden="true" /></button>}
    </div>
    <p className="desktop-update-result" role="status">{error || state?.error || (state?.release ? `Version ${state.release.version} is available. Download the installer, then quit Remix Studio before replacing the app.`
      : state?.status === "current" ? "You’re on the latest release for your channel." : "")}</p>
    {state?.checkedAt && <p className="desktop-update-time">Last checked {new Date(state.checkedAt).toLocaleString()}</p>}
  </section>;
}
