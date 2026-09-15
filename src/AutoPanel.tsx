import {
  AudioLines,
  Check,
  ChevronDown,
  Clapperboard,
  Expand,
  LoaderCircle,
  Scissors,
  Sparkles,
  Subtitles,
} from "lucide-react";
import type { AutoCapabilities, AutoOptions } from "../shared/types";

export const AUTO_FORMAT_NAMES: Record<AutoOptions["aspect"], string> = {
  "9:16": "TikTok & Reels",
  "1:1": "Square posts",
  "4:5": "Instagram feed",
  "16:9": "Landscape",
  original: "Original format",
};

export default function AutoPanel({
  options,
  onChange,
  capabilities,
  variants,
  onVariantsChange,
}: {
  options: AutoOptions;
  onChange: (value: AutoOptions) => void;
  capabilities: AutoCapabilities | null;
  variants: number;
  onVariantsChange: (value: number) => void;
}) {
  const formatName = AUTO_FORMAT_NAMES[options.aspect];
  return (
    <aside className="auto-panel panel">
      <div className="panel-heading">
        <h2>
          <Sparkles size={16} />
          Your automatic edit
        </h2>
        <span className="auto-badge">AUTO</span>
      </div>
      <div className="auto-panel-body">
        <div className="auto-promise">
          <span className="auto-promise-icon">
            <Wand />
          </span>
          <h2>
            You bring the footage.
            <br />
            <span>We'll find the edit.</span>
          </h2>
          <p>
            Every video gets its own cut. Just upload your batch and press Auto
            remix.
          </p>
        </div>
        <div className="auto-pipeline">
          <div>
            <span>
              <AudioLines size={15} />
            </span>
            <div>
              <h3>Find the story</h3>
              <p>
                {capabilities?.transcription
                  ? "Transcribe speech and pick a focused excerpt."
                  : "Analyze timing and select an excerpt."}
              </p>
            </div>
          </div>
          <div>
            <span>
              <Scissors size={15} />
            </span>
            <div>
              <h3>Make the cut</h3>
              <p>
                {capabilities?.transcription
                  ? "Tighten pauses and build an opening hook."
                  : "Build visual cuts and reframe your footage."}
              </p>
            </div>
          </div>
          <div>
            <span>
              <Subtitles size={15} />
            </span>
            <div>
              <h3>Give it a fresh finish</h3>
              <p>
                {capabilities?.transcription
                  ? "Add speech captions, callouts and gentle motion."
                  : "Add framing, gentle motion and balanced sound."}
              </p>
            </div>
          </div>
        </div>
        <div className="auto-output-summary">
          <div>
            <Expand size={14} />
            <span>{formatName}</span>
            <strong>
              {options.aspect === "original" ? "Source" : options.aspect}
            </strong>
          </div>
          <div>
            <Clapperboard size={14} />
            <span>Up to {options.targetDuration} seconds</span>
            <span className="auto-original-voice">
              {options.narration ? "New narration" : "Original voice"}
            </span>
          </div>
        </div>
        <details className="auto-preferences">
          <summary>
            Adjust output{" "}
            <span>
              Optional
              <ChevronDown size={13} />
            </span>
          </summary>
          <div className="auto-preferences-content">
            <label>
              Format
              <select
                value={options.aspect}
                onChange={(event) =>
                  onChange({
                    ...options,
                    aspect: event.target.value as AutoOptions["aspect"],
                  })
                }
              >
                {Object.entries(AUTO_FORMAT_NAMES).map(([aspect, name]) => (
                  <option key={aspect} value={aspect}>
                    {aspect === "original" ? name : `${aspect} · ${name}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Target length
              <select
                value={options.targetDuration}
                onChange={(event) =>
                  onChange({
                    ...options,
                    targetDuration: Number(
                      event.target.value,
                    ) as AutoOptions["targetDuration"],
                  })
                }
              >
                <option value={30}>Up to 30 seconds</option>
                <option value={45}>Up to 45 seconds</option>
                <option value={60}>Up to 60 seconds</option>
              </select>
            </label>
            <label>
              Versions per video
              <select
                value={variants}
                onChange={(event) =>
                  onVariantsChange(Number(event.target.value))
                }
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option value={value} key={value}>
                    {value} {value === 1 ? "version" : "versions"}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={`auto-narration-toggle ${!capabilities?.narration ? "unavailable" : ""}`}
            >
              <span>
                <strong>New narration</strong>
                <small>
                  {capabilities?.narration
                    ? "Replace the original voice with a fresh scripted read."
                    : "Narration is unavailable on this engine. Original audio is kept."}
                </small>
              </span>
              <input
                type="checkbox"
                disabled={!capabilities?.narration}
                checked={options.narration && !!capabilities?.narration}
                onChange={(event) =>
                  onChange({ ...options, narration: event.target.checked })
                }
              />
            </label>
            <p className="auto-preferences-note">
              Shorter videos stay short. Automatic edits use their own settings;
              manual edits are kept in Manual mode.
            </p>
          </div>
        </details>
        {capabilities === null ? (
          <div className="auto-capability-note">
            <LoaderCircle size={12} className="spin" />
            <span>Checking automatic editing tools…</span>
          </div>
        ) : capabilities.message ? (
          <div className="auto-capability-note">
            <span>{capabilities.message}</span>
          </div>
        ) : (
          <div className="auto-capability-note">
            <Check size={12} />
            <span>
              {capabilities.transcription
                ? "Speech-aware editing is ready."
                : "Automatic visual editing is ready."}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

function Wand() {
  return <Sparkles size={22} strokeWidth={1.6} />;
}
