import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Copy,
  Expand,
  LoaderCircle,
  Scissors,
  Sparkles,
} from "lucide-react";
import type {
  AutoCapabilities,
  AutoOptions,
  VideoSource,
} from "../shared/types";
import { DEFAULT_BROLL_COUNT, MAX_AUTO_VERSIONS, MAX_BROLL_COUNT } from "../shared/types";
import BrollPanel from "./BrollPanel";
import "./auto-panel.css";

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
  const brollCount = options.brollCount ?? DEFAULT_BROLL_COUNT;
  const [brollCountInput, setBrollCountInput] = useState(String(brollCount));
  useEffect(() => setBrollCountInput(String(brollCount)), [brollCount, selectedId]);
  const [versionInput, setVersionInput] = useState(String(variants));
  useEffect(() => setVersionInput(String(variants)), [variants, selectedId]);
  const commitVersions = () => {
    const parsed = Number(versionInput);
    const count = versionInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(MAX_AUTO_VERSIONS, Math.floor(parsed))) : variants;
    setVersionInput(String(count));
    onVariantsChange(count);
  };
  const commitBrollCount = () => {
    const parsed = Number(brollCountInput);
    const count = brollCountInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(MAX_BROLL_COUNT, Math.floor(parsed))) : brollCount;
    setBrollCountInput(String(count));
    onChange({ ...options, brollCount: count });
  };
  return (
    <aside className="auto-panel panel">
      <div className="panel-heading">
        <h2>
          <Sparkles size={16} />
          Auto editor
        </h2>
        <span className="auto-badge">Guided edit</span>
      </div>
      <div className="auto-panel-body">
        <div className="auto-scope">
          <label htmlFor="auto-source">
            {sources.length
              ? "Editing preferences for"
              : "Starting preferences"}
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
              ? "These preferences belong to the selected video."
              : "Add footage when you're ready. These preferences will apply to new videos."}
          </p>
          {sources.length > 1 && (
            <button type="button" disabled={libraryBusy} onClick={onApplyAll}>
              <Copy size={14} /> Use for all {sources.length} videos
            </button>
          )}
          {sources.length > 1 && (
            <small>
              Includes B-roll and version count. Also applies to new imports.
            </small>
          )}
          {libraryBusy && (
            <small role="status">
              Finish the B-roll update before switching videos.
            </small>
          )}
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
        <details className="auto-preferences" open>
          <summary>
            Output preferences{" "}
            <span>
              <ChevronDown size={13} />
            </span>
          </summary>
          <div className="auto-preferences-content">
            <label className="auto-output-field">
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
            <label className="auto-output-field">
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
            <label className="auto-output-field">
              Maximum versions
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_AUTO_VERSIONS}
                step={1}
                value={versionInput}
                aria-describedby="auto-version-note"
                onChange={(event) => {
                  setVersionInput(event.target.value);
                  const count = event.target.valueAsNumber;
                  if (Number.isInteger(count) && count >= 1 && count <= MAX_AUTO_VERSIONS)
                    onVariantsChange(count);
                }}
                onBlur={commitVersions}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </label>
            <p id="auto-version-note" className="auto-preferences-note">
              1–{MAX_AUTO_VERSIONS} per video. Similar cuts are skipped, so you may get fewer versions.
            </p>
            <label className="auto-output-field">
              Editorial review
              <select value={options.editorialMode ?? "repair"} onChange={(event) => onChange({ ...options, editorialMode: event.target.value as AutoOptions["editorialMode"] })}>
                <option value="repair">Check and repair · up to 2 attempts</option>
                <option value="check">Check only</option>
                <option value="off">Off</option>
              </select>
            </label>
            <p className="auto-preferences-note">DeepSeek checks the opening, meaning, and ending against the original transcript. Repair mode can try up to two corrections, keeping proposals only when the follow-up check reports fewer issues. Models can miss problems; review the finished short.</p>
            <p className="auto-preferences-note">When available, AI selection, checks, and repairs use {capabilities?.intelligenceModel ? `DeepSeek · ${capabilities.intelligenceModel}` : "DeepSeek"}. Bounded transcript excerpts, captions, headings, and edit metadata are sent to DeepSeek. Transcription and rendering stay on this computer.</p>
            <label
              className={`auto-narration-toggle ${!capabilities?.narration ? "unavailable" : ""}`}
            >
              <span>
                <strong>New narration</strong>
                <small>
                  {capabilities?.narration
                    ? "Replace the original voice with a scripted read."
                    : "Unavailable on this engine. Original audio is kept."}
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
                Supporting visuals
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
                <option value="off">Original footage only</option>
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
                Optional cutaways at relevant moments. Your main audio continues
                underneath.
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
                    using your speech. Each selected interval is checked for
                    motion and crop suitability. If nothing fits, your original
                    picture stays.
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
                      configured on the server. Until then, exports keep your
                      original footage.
                    </p>
                  )}
                </div>
              )}
              {(options.supportingVisuals === "graphics" ||
                options.supportingVisuals === "both") && (
                <p className="auto-preferences-note">
                  Animated text cards turn key points from your video's speech
                  into supporting visuals.
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
                  <div className="broll-count">
                    <label className="auto-output-field">
                      B-roll shots to aim for
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MAX_BROLL_COUNT}
                        step={1}
                        value={brollCountInput}
                        aria-describedby="auto-broll-count-note"
                        onChange={(event) => {
                          setBrollCountInput(event.target.value);
                          const count = event.target.valueAsNumber;
                          if (Number.isInteger(count) && count >= 1 && count <= MAX_BROLL_COUNT)
                            onChange({ ...options, brollCount: count });
                        }}
                        onBlur={commitBrollCount}
                        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                      />
                    </label>
                    <p id="auto-broll-count-note" className="auto-preferences-note">
                      Aim for 1–{MAX_BROLL_COUNT} relevant moving shots per video.
                      You may get fewer if suitable matches aren't available.
                      Higher counts take longer.
                    </p>
                  </div>
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
                        Meaning &amp; visual matching · DeepSeek
                      </option>
                    </select>
                    {options.brollMatching === "ai" ? (
                      <p className="auto-preferences-note">
                        Sends sampled B-roll frames and transcript excerpts to
                        DeepSeek.{" "}
                        {options.supportingVisuals === "stock"
                          ? "Uses surrounding speech to find relevant shots. Previous inspections are reused."
                          : "Checks selected clips for a relevant match. Previous inspections are reused."}
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
                          : "Add a DeepSeek API key on the server to enable AI matching."}
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
          </div>
        </details>
        <div className="auto-workflow-note">
          <Scissors size={16} />
          <p>
            {capabilities?.transcription
              ? "Auto selects an excerpt and adds captions. You can refine the cut, text, and visuals after rendering."
              : "Auto selects and reframes footage. You can refine the cut and visuals after rendering."}
          </p>
        </div>
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
