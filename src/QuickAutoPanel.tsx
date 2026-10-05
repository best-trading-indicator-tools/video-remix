import { SlidersHorizontal, Zap } from "lucide-react";
import type { AutoOptions } from "../shared/types";
import { MAX_AUTO_VERSIONS } from "../shared/types";
import { MAX_ANGLE_VERSIONS } from "../shared/version-angles";
import OwnFootagePanel, { type FootageTarget } from "./OwnFootagePanel";
import "./quick-auto.css";

export type AutoView = "quick" | "all";
export type QuickPatch = { options?: Partial<AutoOptions>; variants?: number };

/** Switch between the short everyday setup and every Auto control. */
export function AutoViewSwitch({ view, onView }: { view: AutoView; onView: (view: AutoView) => void }) {
  return <div className="auto-view-switch" role="group" aria-label="Auto settings view">
    <button type="button" aria-pressed={view === "quick"} onClick={() => onView("quick")}><Zap size={13} />Quick</button>
    <button type="button" aria-pressed={view === "all"} onClick={() => onView("all")}><SlidersHorizontal size={13} />All settings</button>
  </div>;
}

const PLATFORMS: { aspect: AutoOptions["aspect"]; name: string; detail: string }[] = [
  { aspect: "9:16", name: "TikTok, Reels & Shorts", detail: "Vertical · 9:16" },
  { aspect: "4:5", name: "Instagram feed", detail: "Portrait · 4:5" },
  { aspect: "1:1", name: "Square posts", detail: "Square · 1:1" },
  { aspect: "16:9", name: "YouTube & landscape", detail: "Wide · 16:9" },
];
const LENGTHS = [15, 30, 45, 60, 90];
const VERSION_MODES = [
  { mode: "moments", name: "A different moment", detail: "Each clip uses new footage from the video." },
  { mode: "angles", name: "New angles on one moment", detail: "Conclusion first, question first, then key points." },
] as const;

export default function QuickAutoPanel({ options, variants, mixed, scopeDescription, onChange, onView, selectedId, selectedVideos, onApplySelectedFootage, disabled }: {
  scopeDescription: string; options: AutoOptions; variants: number; mixed: boolean;
  onChange: (patch: QuickPatch) => void; onView: (view: AutoView) => void;
  selectedId?: string; selectedVideos: FootageTarget[]; disabled: boolean;
  onApplySelectedFootage: (placements: NonNullable<AutoOptions['ownFootage']>) => void;
}) {
  const angles = options.versionMode === "angles";
  const maxClips = angles ? MAX_ANGLE_VERSIONS : MAX_AUTO_VERSIONS;
  return <aside className="auto-panel panel quick-auto">
    <div className="panel-heading"><h2><Zap size={16} />Quick setup</h2><AutoViewSwitch view="quick" onView={onView} /></div>
    <div className="auto-panel-body">
      <p className="quick-auto-scope">
        {scopeDescription}. Only the setting you change is copied.
        {mixed && " Videos have different settings; these controls show the current video's values."}
      </p>
      <fieldset className="quick-auto-group">
        <legend>Where will you post?</legend>
        <div className="quick-auto-options">{PLATFORMS.map(platform =>
          <label key={platform.aspect} className="quick-auto-option">
            <input type="radio" name="quick-auto-aspect" checked={options.aspect === platform.aspect} onChange={() => onChange({ options: { aspect: platform.aspect } })} />
            <span><strong>{platform.name}</strong><small>{platform.detail}</small></span>
          </label>)}
        </div>
        {!PLATFORMS.some(platform => platform.aspect === options.aspect) && <p className="auto-preferences-note">Currently: original format, set in All settings.</p>}
      </fieldset>
      <fieldset className="quick-auto-group">
        <legend>How long can each clip be?</legend>
        <div className="quick-auto-chips">{LENGTHS.map(seconds =>
          <label key={seconds} className="quick-auto-chip">
            <input type="radio" name="quick-auto-length" checked={options.targetDuration === seconds} onChange={() => onChange({ options: { targetDuration: seconds } })} />
            <span>{seconds}s</span>
          </label>)}
        </div>
        <p className="auto-preferences-note">{LENGTHS.includes(options.targetDuration) ? "An upper limit: Auto keeps a complete idea shorter when it fits." : `Currently up to ${options.targetDuration}s, set in All settings.`}</p>
      </fieldset>
      <fieldset className="quick-auto-group">
        <legend>How many clips per video?</legend>
        <div className="quick-auto-stepper">
          <button type="button" aria-label="Fewer clips per video" disabled={variants <= 1} onClick={() => onChange({ variants: variants - 1 })}>−</button>
          <output aria-live="polite" aria-label="Clips per video">{variants}</output>
          <button type="button" aria-label="More clips per video" disabled={variants >= maxClips} onClick={() => onChange({ variants: variants + 1 })}>+</button>
        </div>
        <div className="quick-auto-options quick-auto-two">{VERSION_MODES.map(choice =>
          <label key={choice.mode} className="quick-auto-option">
            <input type="radio" name="quick-auto-versions" checked={(options.versionMode ?? "moments") === choice.mode}
              onChange={() => onChange({ options: { versionMode: choice.mode } })} />
            <span><strong>{choice.name}</strong><small>{choice.detail}</small></span>
          </label>)}
        </div>
        {angles && <p className="auto-preferences-note">Up to {MAX_ANGLE_VERSIONS} clips per video, one per angle, in the original voice.</p>}
      </fieldset>
      <OwnFootagePanel key={selectedId || "default"} value={options.ownFootage}
        onChange={ownFootage => onChange({ options: { ownFootage } })} disabled={disabled}
        selectedVideos={selectedVideos} onApplySelected={onApplySelectedFootage} />
    </div>
  </aside>;
}
