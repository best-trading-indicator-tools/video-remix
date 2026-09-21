import OwnFootagePanel from "./OwnFootagePanel";
import { CaptionAppearance } from "./CaptionStyleEditor";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Copy,
  Expand,
  Film,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Scissors,
  Shapes,
  Sparkles,
} from "lucide-react";
import type {
  AutoCapabilities,
  AutoOptions,
  VideoSource,
  VisualSource,
} from "../shared/types";
import { DEFAULT_BROLL_COUNT, DEFAULT_BROLL_MAX_COVERAGE, MAX_AUTO_VERSIONS, MAX_BROLL_COUNT, isAutoTargetDuration } from "../shared/types";
import { AUDIO_LOOKS, audioLookById } from "../shared/audio";
import { getVisualSources, getBrollMatching, hasGraphicVisuals, hasLibraryVisuals, hasStockVisuals, VISUAL_SOURCE_LABELS } from "../shared/visual-sources";
import BrollPanel from "./BrollPanel";
import FinishingPresets from "./FinishingPresets";
import BlackBandsEditor from "./BlackBandsEditor";
import { applyBandFinish } from "../shared/black-bands";
import PacingOptions from "./PacingOptions";
import "./pacing.css";
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
  const selectedSource = sources.find(source => source.id === selectedId);
  const outputAspect = options.aspect === "original" ? (selectedSource ? selectedSource.width / selectedSource.height : 9 / 16)
    : Number(options.aspect.split(":")[0]) / Number(options.aspect.split(":")[1]);
  const keepOriginalCaptions = options.captions === "keep";
  const narrationAvailable = !!capabilities?.narration && !keepOriginalCaptions;
  const visualSources = getVisualSources(options);
  const stockSelected = hasStockVisuals(options);
  const aiMatching = getBrollMatching(options) === "ai";
  const librarySelected = hasLibraryVisuals(options);
  const graphicsSelected = hasGraphicVisuals(options);
  const visualChoices: { id: VisualSource; description: string; icon: typeof Film; available: boolean; setup: string }[] = [
    { id: "pixabay", description: "Moving stock footage", icon: Film, available: capabilities?.stockProviders?.includes("pixabay") ?? !!capabilities?.stockBroll, setup: "Add a Pixabay API key to enable stock search." },
    { id: "pexels", description: "Moving stock footage", icon: Film, available: !!capabilities?.stockProviders?.includes("pexels"), setup: "Add a Pexels API key to enable stock search." },
    { id: "hyperframes", description: "Illustrated explainers", icon: Layers3, available: !!capabilities?.motionGraphics, setup: "HyperFrames renderer is unavailable on this engine." },
    { id: "remotion", description: "Illustrated explainers", icon: Shapes, available: !!capabilities?.remotionGraphics, setup: "Remotion renderer is unavailable on this engine." },
    { id: "library", description: "Your uploaded clips", icon: FolderOpen, available: true, setup: "" },
  ];
  const toggleVisualSource = (source: VisualSource, enabled: boolean) => onChange({
    ...options,
    visualSources: enabled ? [...visualSources, source] : visualSources.filter((item) => item !== source),
    ...((source === "pixabay" || source === "pexels") && enabled
      ? { brollMatching: "ai" as const } : {}),
  });
  const brollCount = options.brollCount ?? DEFAULT_BROLL_COUNT;
  const [durationInput, setDurationInput] = useState(String(options.targetDuration));
  useEffect(() => setDurationInput(String(options.targetDuration)), [options.targetDuration, selectedId]);
  const commitDuration = () => {
    const parsed = Number(durationInput);
    const duration = durationInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed))) : options.targetDuration;
    setDurationInput(String(duration));
    onChange({ ...options, targetDuration: duration });
  };
  const coverage = options.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE;
  const [coverageInput, setCoverageInput] = useState(String(coverage));
  useEffect(() => setCoverageInput(String(coverage)), [coverage, selectedId]);
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
        <OwnFootagePanel key={selectedId || "default"} value={options.ownFootage} onChange={ownFootage => onChange({ ...options, ownFootage })} disabled={libraryBusy} />
      <FinishingPresets mode="auto" settings={options} disabled={libraryBusy} onApply={patch => onChange({ ...options, ...patch, blackBands: applyBandFinish(options.blackBands, patch.blackBands) })} />
        <PacingOptions value={options.pacing} onChange={pacing => onChange({ ...options, pacing })} disabled={libraryBusy} />
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
              Includes visual sources and version count. Also applies to new imports.
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
              {options.narration && narrationAvailable
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
            <BlackBandsEditor value={options.blackBands} onChange={blackBands => onChange({ ...options, blackBands })}
              source={selectedSource} aspect={outputAspect} />
            <label className="auto-output-field">
              Target length (seconds)
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={durationInput}
                aria-describedby="auto-duration-note"
                onChange={(event) => {
                  setDurationInput(event.target.value);
                  const duration = event.target.valueAsNumber;
                  if (isAutoTargetDuration(duration)) onChange({ ...options, targetDuration: duration });
                }}
                onBlur={commitDuration}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </label>
            <p id="auto-duration-note" className="auto-preferences-note">
              Any whole number from 1 second. Auto may choose a shorter excerpt; it never extends the original footage.
            </p>
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
              Captions
              <select value={options.captions ?? "auto"} aria-describedby="auto-captions-note"
                onChange={(event) => onChange({ ...options, captions: event.target.value as AutoOptions["captions"] })}>
                <option value="auto">Auto · avoid duplicates</option>
                <option value="add">Add new captions</option>
                <option value="keep">Keep original · add none</option>
              </select>
            </label>
            <p id="auto-captions-note" className="auto-preferences-note">
              {options.captions === "keep"
                ? "Keeps the original voice and captions. Adds no captions, hook or callouts."
                : options.captions === "add"
                  ? "Adds captions from speech. Any captions already in the original picture remain visible."
                  : "Auto checks for captions baked into the selected footage. If found or uncertain, it keeps the original voice and adds no captions, hook or callouts."}
            </p>
            {options.captions !== "keep" && <CaptionAppearance value={options.captionStyle} onChange={captionStyle => onChange({ ...options, captionStyle })} />}
            <label className="auto-output-field">
              Sound
              <select value={options.audio ?? "auto"} aria-describedby="auto-audio-note"
                onChange={(event) => onChange({ ...options, audio: event.target.value as AutoOptions["audio"] })}>
                <option value="auto">Auto · measure and choose</option>
                <option value="off">Leave the sound untouched</option>
                {AUDIO_LOOKS.filter(look => look.id !== "original").map(look => (
                  <option key={look.id} value={look.id}>{look.name}</option>
                ))}
              </select>
            </label>
            <p id="auto-audio-note" className="auto-preferences-note">
              {options.audio === "off" || options.audio === "original"
                ? "Keeps the original tone, noise and dynamics. Loudness is still evened out across the cuts."
                : options.audio && options.audio !== "auto"
                  ? `${audioLookById(options.audio)?.description} Applied to every version in this batch.`
                  : "Measures the selected speech on this computer — its noise floor, level spread and tone balance — and applies the closest-fitting sound look. Sources with no recognized speech are left untouched."}
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
            <label className="auto-narration-toggle"><span><strong>Review finished picture &amp; sound</strong><small>Inspect sampled source/export frames and compare captions with the rendered soundtrack. Adds processing time.</small></span><input type="checkbox" checked={options.finishedReview !== false} onChange={event => onChange({ ...options, finishedReview: event.target.checked })} /></label>
            <p className="auto-preferences-note">Finished picture review sends sampled frames and recognized speech to DeepSeek. Audio transcription runs locally. Findings are advisory and never block your download.</p>
            <p className="auto-preferences-note">When available, AI selection, checks, and repairs use {capabilities?.intelligenceModel ? `DeepSeek · ${capabilities.intelligenceModel}` : "DeepSeek"}. Bounded transcript excerpts, captions, headings, and edit metadata are sent to DeepSeek. Transcription and rendering stay on this computer.</p>
            <label
              className={`auto-narration-toggle ${!narrationAvailable ? "unavailable" : ""}`}
            >
              <span>
                <strong>New narration</strong>
                <small>
                  {keepOriginalCaptions
                    ? "Keep original preserves the source voice to match its captions."
                    : !capabilities?.narration
                      ? "Unavailable on this engine. Original audio is kept."
                      : options.captions !== "add"
                        ? "Replace the voice with a scripted read. Auto keeps the original voice if source captions are found or detection is uncertain."
                        : "Replace the original voice with a scripted read."}
                </small>
              </span>
              <input
                type="checkbox"
                disabled={!narrationAvailable}
                checked={options.narration && narrationAvailable}
                onChange={(event) =>
                  onChange({ ...options, narration: event.target.checked })
                }
              />
            </label>
            <div className="supporting-visuals">
              <fieldset className="auto-visual-sources" disabled={libraryBusy} aria-describedby="auto-visual-sources-note">
                <legend>Supporting visuals</legend>
                <p id="auto-visual-sources-note" className="auto-preferences-note">Choose any combination. Leave all off to keep only your footage.</p>
                <div className="auto-visual-options">
                  {visualChoices.map(({ id, description, icon: Icon, available, setup }) => {
                    const checked = visualSources.includes(id);
                    return <label className={`auto-visual-choice ${checked ? "is-selected" : ""} ${!available ? "is-unavailable" : ""}`} key={id}>
                      <input type="checkbox" aria-label={`${VISUAL_SOURCE_LABELS[id]} ${(id === "pixabay" || id === "pexels") ? "stock footage" : id === "library" ? "uploaded clips" : "animated cards"}`}
                        checked={checked} disabled={!available && !checked}
                        onChange={(event) => toggleVisualSource(id, event.target.checked)} />
                      <span className="auto-visual-icon" aria-hidden="true"><Icon size={18} /></span>
                      <span className="auto-visual-copy"><strong>{VISUAL_SOURCE_LABELS[id]}</strong><span>{description}</span>
                        {!available && <small>{capabilities === null ? "Checking availability…" : setup}{checked && " You can remove this selection."}</small>}
                      </span>
                    </label>;
                  })}
                </div>
                {visualSources.length > 0 ? <button type="button" className="auto-visual-clear" onClick={() => onChange({ ...options, visualSources: [] })}>Use original footage only</button>
                  : <p className="auto-visual-empty">Original footage only. No supporting shots will be added.</p>}
              </fieldset>
              <p className="auto-preferences-note">Stock videos provided by <a href="https://www.pexels.com" target="_blank" rel="noreferrer">Pexels</a> and <a href="https://pixabay.com" target="_blank" rel="noreferrer">Pixabay</a>. Creator credits accompany each selected clip.</p>
              {graphicsSelected && !capabilities?.intelligence && <p className="auto-preferences-note">Configure DeepSeek to plan illustrated explainers. Without it, the original picture is kept.</p>}
              {graphicsSelected && <p className="auto-preferences-note">DeepSeek designs illustrations, diagrams and comparisons for the current spoken idea. Charts use only numbers stated in the speech. Both renderers animate them locally; your main audio continues underneath.</p>}
              {stockSelected && (
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
                      Animations only · Pixabay
                    </option>
                  </select>
                  <p className="auto-preferences-note">Searches your selected stock libraries using the speech. Each chosen interval is checked for motion and crop suitability. Animation-only filtering is available on Pixabay.</p>
                  {!capabilities?.stockBroll && <p className="auto-preferences-note" role="status">Add a free Pixabay or Pexels API key on the server to enable stock search.</p>}
                </div>
              )}
              {visualSources.length > 0 && (
                  <div className="broll-count">
                    <label className="auto-output-field">
                      Total supporting shots
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
                    <label className="auto-output-field">Maximum B-roll coverage (%)
                      <input type="number" inputMode="numeric" min={0} max={100} step={1} value={coverageInput}
                        onChange={event => { setCoverageInput(event.target.value); const n = event.target.valueAsNumber; if (Number.isInteger(n) && n >= 0 && n <= 100) onChange({ ...options, brollMaxCoverage: n }); }}
                        onBlur={() => { const n = coverageInput.trim() ? Number(coverageInput) : coverage; const limit = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : coverage; setCoverageInput(String(limit)); onChange({ ...options, brollMaxCoverage: limit }); }} />
                    </label>
                    <p className="auto-preferences-note">Stock, uploaded B-roll and animation cards together can cover at most {coverage}% of the result. A 30-second video allows {(30 * coverage / 100).toFixed(1)} seconds. We may use fewer shots to respect this limit.</p>
                    <p id="auto-broll-count-note" className="auto-preferences-note">
                      Request 1–{MAX_BROLL_COUNT} visuals in total across your selected sources. We keep searching and adjusting placement to fill the count.
                      Up to three passes try additional clips and shorter placements. Any unfilled places are reported with the result; higher counts take longer.
                    </p>
                    {brollCount < visualSources.length && <p className="auto-preferences-note" role="status">The target is smaller than your source selection. Not every source can appear in this edit.</p>}
                  </div>
              )}
              {(stockSelected || librarySelected) && (
                <>
                  <div className="broll-matching">
                    {stockSelected ? <strong>Meaning &amp; visual matching · DeepSeek</strong> : <>
                    <label htmlFor="broll-matching">Match B-roll using</label>
                    <select
                      id="broll-matching"
                      value={getBrollMatching(options)}
                      onChange={(event) =>
                        onChange({
                          ...options,
                          brollMatching: event.target.value as "tags" | "ai",
                        })
                      }
                    >
                      <option value="tags">
                        Filename &amp; tags · local
                      </option>
                      <option value="ai" disabled={!capabilities?.brollAI}>
                        Meaning &amp; visual matching · DeepSeek
                      </option>
                    </select></>}
                    {aiMatching ? (
                      <p className="auto-preferences-note">
                        Sends sampled B-roll frames and transcript excerpts to
                        DeepSeek.{" "}
                        {stockSelected
                          ? "Stock footage is always checked against the surrounding speech and sampled images. Unrelated or unclear shots are skipped; the requested count is best effort. Previous inspections are reused."
                          : "Checks selected clips for a relevant match. Previous inspections are reused."}
                      </p>
                    ) : (
                      <p className="auto-preferences-note">
                        Matches words from the transcript to clip filenames and tags.{" "}
                        Clips without a match are skipped.
                      </p>
                    )}
                    {capabilities && !capabilities.brollAI && (
                      <p className="auto-preferences-note">
                        {aiMatching
                          ? "AI matching needs a DeepSeek key on the server. Other selected visual sources can still be used."
                          : "Add a DeepSeek API key on the server to enable AI matching."}
                      </p>
                    )}
                  </div>
                  {librarySelected && (
                    <BrollPanel
                      key={selectedId || "new-imports"}
                      selectedIds={options.brollIds || []}
                      onSelectionChange={onBrollSelectionChange}
                      onBusyChange={onLibraryBusyChange}
                      onRemoved={onBrollRemoved}
                      aiMatching={aiMatching}
                      maxFiles={maxFiles}
                      maxFileSize={maxFileSize}
                    />
                  )}
                  {librarySelected && !options.brollIds?.length && visualSources.length > 1 && <p className="auto-preferences-note">No uploaded clips selected. The other visual sources can still be used.</p>}
                </>
              )}
            </div>
          </div>
        </details>
        <div className="auto-workflow-note">
          <Scissors size={16} />
          <p>
            {capabilities?.transcription
              ? "Auto selects an excerpt and follows your caption preferences. You can refine the cut, text, and visuals after rendering."
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
