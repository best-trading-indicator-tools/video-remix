import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import type { RenderJob } from "../shared/types";
import { BatchCompletionTracker } from "../shared/processing-time";
const storageKey = "remix-batch-notifications";
export default function BatchNotifications({ jobs, visible, onOpen }: { jobs: RenderJob[]; visible: boolean; onOpen: () => void }) {
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem(storageKey) === "on"; } catch { return false; } });
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const tracker = useRef(new BatchCompletionTracker());
  const openRef = useRef(onOpen); openRef.current = onOpen;
  useEffect(() => window.remixDesktop?.onOpenExports(() => openRef.current()), []);
  useEffect(() => {
    for (const complete of tracker.current.observe(jobs)) {
      setNotice(`Collection finished: ${complete.body}.`);
      if (!enabled) continue;
      if (window.remixDesktop?.notifyBatch) {
        void window.remixDesktop.notifyBatch(complete.body).then(shown => {
          if (!shown && mounted.current) setMessage("System notifications are unavailable. The app will show a completion notice; desktop builds also signal in the taskbar or Dock when possible.");
        }).catch(() => { if (mounted.current) setMessage("System notifications are unavailable. Completion notices still appear here."); });
      } else if ("Notification" in window && Notification.permission === "granted") {
        try { const notification = new Notification("Remix Studio · Collection finished", { body: complete.body, tag: complete.id }); notification.onclick = () => { window.focus(); openRef.current(); notification.close(); }; }
        catch { setMessage("This browser could not show a system notification. Completion notices still appear here."); }
      } else setMessage("Notifications are blocked by your browser. Allow them in site settings; completion notices still appear here.");
    }
  }, [jobs, enabled]);
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      if (!enabled && !window.remixDesktop?.notifyBatch) {
        if (!("Notification" in window)) { setMessage("This browser supports in-app completion notices only."); return; }
        if (await Notification.requestPermission() !== "granted") { setMessage("Allow notifications in your browser’s site settings to receive desktop alerts."); return; }
      }
      const next = !enabled; setEnabled(next);
      try { localStorage.setItem(storageKey, next ? "on" : "off"); } catch { setMessage("This preference lasts until the app closes because storage is unavailable."); }
    } finally { setBusy(false); }
  };
  return <>
    {notice && <div className="batch-completion-notice" role="status"><CheckCheck size={18} /><span>{notice}</span><button className="secondary-button" onClick={() => { setNotice(""); onOpen(); }}>View exports</button><button className="icon-button" aria-label="Dismiss completion notice" onClick={() => setNotice("")}><X size={16} /></button></div>}
    {visible && <div className="batch-notifications"><button className="secondary-button" aria-pressed={enabled} disabled={busy} onClick={() => void toggle()}><Bell size={15} />{enabled ? "Completion notifications on" : "Notify me when finished"}</button><span>For collections taking over a minute. Keep Remix Studio open.</span>{message && <p role="status">{message}</p>}</div>}
  </>;
}
