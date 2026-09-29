import { Palette, SlidersHorizontal, Zap } from "lucide-react";
import type { AutoOptions } from "../shared/types";
import { MAX_AUTO_VERSIONS } from "../shared/types";
import { MAX_ANGLE_VERSIONS } from "../shared/version-angles";
import { describeMyStyle, type MyStyle } from "../shared/my-style";
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

export default function QuickAutoPanel({ options, variants, videoCount, mixed, style, onChange, onSaveStyle, onApplyStyle, onView }: {
  options: AutoOptions; variants: number; videoCount: number; mixed: boolean; style: MyStyle | null;
  onChange: (patch: QuickPatch) => void; onSaveStyle: () => void; onApplyStyle: () => void; onView: (view: AutoView) => void;
}) {
  const angles = options.versionMode === "angles";
  const maxClips = angles ? MAX_ANGLE_VERSIONS : MAX_AUTO_VERSIONS;
  return <aside className="auto-panel panel quick-auto">
    <div className="panel-heading"><h2><Zap size={16} />Quick setup</h2><AutoViewSwitch view="quick" onView={onView} /></div>
    <div className="auto-panel-body">
      <p className="quick-auto-scope">
        {videoCount > 1 ? `Choices here apply to all ${videoCount} videos and to new imports.`
          : videoCount ? "Choices here apply to this video and to new imports." : "Choices here are saved for your next imports."}
        {mixed && " Some videos had their own Auto settings; a choice here replaces that setting for every video."}
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
      <section className="quick-auto-style" aria-labelledby="quick-auto-style-title">
        <h3 id="quick-auto-style-title"><Palette size={14} />Your style</h3>
        {style ? <>
          <ul>{describeMyStyle(style).map(item => <li key={item}>{item}</li>)}</ul>
          <div className="quick-auto-style-actions">
            <button type="button" onClick={onApplyStyle} disabled={!videoCount}>Apply to all videos</button>
            <button type="button" onClick={onSaveStyle}>Replace with the current look</button>
          </div>
        </> : <>
          <p>Save your caption look, black bands, pacing and sound once. Auto and Manual then use them for every video and new import.</p>
          <div className="quick-auto-style-actions"><button type="button" onClick={onSaveStyle}>Save the current look as my style</button></div>
        </>}
        <p className="auto-preferences-note">Adjust the look in <button type="button" className="quick-auto-link" onClick={() => onView("all")}>All settings</button>, then save it here.</p>
      </section>
    </div>
  </aside>;
}
