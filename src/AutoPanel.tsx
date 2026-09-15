import {
  AudioLines,
  Check,
  ChevronDown,
  Clapperboard,
  Copy,
  Expand,
  LoaderCircle,
  Scissors,
  Sparkles,
  Subtitles,
} from "lucide-react";
import type {
  AutoCapabilities,
  AutoOptions,
  VideoSource,
} from "../shared/types";
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
  onBrollRemoved,
  sources,
  selectedId,
  onSourceChange,
  onApplyAll,
  libraryBusy,
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
  onBrollRemoved: (id: string) => void;
  sources: VideoSource[];
  selectedId?: string;
  onSourceChange: (id: string) => void;
  onApplyAll: () => void;
  libraryBusy: boolean;
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
        <div className="auto-scope">
          <label htmlFor="auto-source">
            {sources.length
              ? "Settings for this video"
              : "Settings for new imports"}
          </label>
          {sources.length > 0 && (
            <select
              id="auto-source"
              value={selectedId}
              disabled={libraryBusy}
              onChange={(event) => onSourceChange(event.target.value)}
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          )}
          <p>
            {sources.length
              ? "Choose a video to adjust its output. Other videos keep their settings."
              : "Set your starting preferences, then add your footage."}
          </p>
          {sources.length > 1 && (
            <button type="button" disabled={libraryBusy} onClick={onApplyAll}>
              <Copy size={14} /> Apply to all {sources.length} videos
            </button>
          )}
          {sources.length > 1 && (
            <small>
              Copies every Auto setting, including B-roll and maximum versions.
              Also used for new imports.
            </small>
          )}
          {libraryBusy && (
            <small role="status">
              Finish the B-roll update before switching videos.
            </small>
          )}
        </div>
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
              {options.narration && capabilities?.narration
                ? "New narration"
                : "Original voice"}
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
              <label htmlFor="supporting-visuals">
                Supporting visuals · optional
              </label>
              <select
                id="supporting-visuals"
                value={options.supportingVisuals || "off"}
                onChange={(event) =>
                  onChange({
                    ...options,
                    supportingVisuals: event.target
                      .value as AutoOptions["supportingVisuals"],
                    ...(event.target.value === "stock" && !options.brollMatching && capabilities?.brollAI
                      ? { brollMatching: "ai" as const } : {}),
                  })
                }
              >
                <option value="off">Off</option>
                <option value="stock">Stock B-roll · Pixabay</option>
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
              <p className="auto-preferences-note">
                Add up to three brief cutaways at relevant moments. Your main
                audio continues underneath.
              </p>
              {options.supportingVisuals === "stock" && (
                <div className="broll-matching">
                  <label htmlFor="stock-video-type">Stock video style</label>
                  <select
                    id="stock-video-type"
                    value={options.stockVideoType || "all"}
                    onChange={(event) =>
                      onChange({
                        ...options,
                        stockVideoType: event.target.value as
                          "all" | "animation",
                      })
                    }
                  >
                    <option value="all">Any moving stock video</option>
                    <option value="animation">
                      Animations &amp; motion graphics only
                    </option>
                  </select>
                  <p className="auto-preferences-note">
                    Finds existing clips from{" "}
                    <a
                      href="https://pixabay.com/videos/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Pixabay
                    </a>{" "}
                    using your edited speech. Moving shots are checked in the output crop. Unmatched moments
                    keep your original picture. No clips to upload.
                  </p>
                  {!capabilities?.stockBroll && (
                    <p className="auto-preferences-note" role="status">
                      Stock search needs a free{" "}
                      <a
                        href="https://pixabay.com/api/docs/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Pixabay API key
                      </a>{" "}
                      configured as PIXABAY_API_KEY on the server. Until then,
                      exports keep your original footage.
                    </p>
                  )}
                </div>
              )}
              {(options.supportingVisuals === "graphics" ||
                options.supportingVisuals === "both") && (
                <p className="auto-preferences-note">
                  Animated text cards turn key points from your video's speech
                  into supporting visuals. Rendered locally with HyperFrames.
                </p>
              )}
              {!capabilities?.motionGraphics &&
                (options.supportingVisuals === "graphics" ||
                  options.supportingVisuals === "both") && (
                  <p className="auto-preferences-note">
                    Animated cards are unavailable on this engine. Your uploaded
                    B-roll can still be used.
                  </p>
                )}
              {(options.supportingVisuals === "stock" ||
                options.supportingVisuals === "library" ||
                options.supportingVisuals === "both") && (
                <>
                  <div className="broll-matching">
                    <label htmlFor="broll-matching">Match B-roll using</label>
                    <select
                      id="broll-matching"
                      value={options.brollMatching || "tags"}
                      onChange={(event) =>
                        onChange({
                          ...options,
                          brollMatching: event.target.value as "tags" | "ai",
                        })
                      }
                    >
                      <option value="tags">
                        {options.supportingVisuals === "stock"
                          ? "Spoken keywords & stock tags"
                          : "Filename & tags · local"}
                      </option>
                      <option value="ai" disabled={!capabilities?.brollAI}>
                        AI meaning &amp; visual matching · DeepSeek
                      </option>
                    </select>
                    {options.brollMatching === "ai" ? (
                      <p className="auto-preferences-note">
                        Sends sampled B-roll frames and transcript excerpts to
                        DeepSeek.{" "}
                        {options.supportingVisuals === "stock"
                          ? "Uses neighboring speech to search by meaning, then inspects up to six stock candidates. Descriptions are cached."
                          : "Analyzes up to 20 selected clips per edit; descriptions are reused."}
                      </p>
                    ) : (
                      <p className="auto-preferences-note">
                        {options.supportingVisuals === "stock"
                          ? "Matches the spoken words to stock clip tags."
                          : "Matches words from the transcript to clip filenames and tags."}{" "}
                        Clips without a match are skipped.
                      </p>
                    )}
                    {!capabilities?.brollAI && (
                      <p className="auto-preferences-note">
                        {options.brollMatching === "ai"
                          ? "AI matching is unavailable. Original footage will be kept until a key is configured."
                          : "AI matching needs DEEPSEEK_API_KEY configured on the server."}
                      </p>
                    )}
                  </div>
                  {options.supportingVisuals !== "stock" && (
                    <BrollPanel
                      key={selectedId || "new-imports"}
                      selectedIds={options.brollIds || []}
                      onSelectionChange={onBrollSelectionChange}
                      onBusyChange={onLibraryBusyChange}
                      onRemoved={onBrollRemoved}
                      aiMatching={options.brollMatching === "ai"}
                      maxFiles={maxFiles}
                      maxFileSize={maxFileSize}
                    />
                  )}
                </>
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
