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
import BrollPanel from "./BrollPanel";

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
  onBrollSelectionChange,
  onLibraryBusyChange,
  maxFiles,
  maxFileSize,
}: {
  options: AutoOptions;
  onChange: (value: AutoOptions) => void;
  capabilities: AutoCapabilities | null;
  variants: number;
  onVariantsChange: (value: number) => void;
  onBrollSelectionChange: (ids: string[]) => void;
  onLibraryBusyChange: (busy: boolean) => void;
  maxFiles?: number;
  maxFileSize?: number;
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
                  ? "Add captions, callouts and optional supporting visuals."
                  : "Reframe footage and balance the source audio."}
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
              Maximum versions
              <select
                value={variants}
                onChange={(event) =>
                  onVariantsChange(Number(event.target.value))
                }
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option value={value} key={value}>
                    Up to {value}
                  </option>
                ))}
              </select>
            </label>
            <p className="auto-preferences-note">
              Per source video. Cuts that repeat another version too closely are
              skipped, so your batch may contain fewer exports.
            </p>
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
            <div className="supporting-visuals">
              <label htmlFor="supporting-visuals">Supporting visuals</label>
              <select
                id="supporting-visuals"
                value={options.supportingVisuals || "off"}
                onChange={(event) =>
                  onChange({
                    ...options,
                    supportingVisuals: event.target
                      .value as AutoOptions["supportingVisuals"],
                  })
                }
              >
                <option value="off">Off</option>
                <option value="library">My B-roll videos</option>
                <option
                  value="graphics"
                  disabled={!capabilities?.motionGraphics}
                >
                  Animated cards
                </option>
                <option value="both" disabled={!capabilities?.motionGraphics}>
                  B-roll + animated cards
                </option>
              </select>
              {(options.supportingVisuals === "graphics" ||
                options.supportingVisuals === "both") && (
                <p className="auto-preferences-note">
                  Animated text cards turn key points from your video's speech
                  into supporting visuals. Rendered locally with HyperFrames.
                </p>
              )}
              {!capabilities?.motionGraphics && (
                <p className="auto-preferences-note">
                  Animated cards are unavailable on this engine. Your uploaded
                  B-roll can still be used.
                </p>
              )}
              {(options.supportingVisuals === "library" ||
                options.supportingVisuals === "both") && (
                <BrollPanel
                  selectedIds={options.brollIds || []}
                  onSelectionChange={onBrollSelectionChange}
                  onBusyChange={onLibraryBusyChange}
                  maxFiles={maxFiles}
                  maxFileSize={maxFileSize}
                />
              )}
            </div>
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
