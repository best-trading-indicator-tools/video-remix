import AutoPromptEditor from "./AutoPromptEditor";
import ProblemNotice from "./ProblemNotice";
import SupportingVisualsEditor from "./SupportingVisualsEditor";
import OwnFootagePanel, { type FootageTarget } from "./OwnFootagePanel";
import { CaptionAppearance } from "./CaptionStyleEditor";
import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Copy,
  Expand,
  LoaderCircle,
  Palette,
  Scissors,
  Sparkles,
} from "lucide-react";
import type {
  AutoCapabilities,
  AutoOptions,
  RemixSettings,
  VideoSource,
} from "../shared/types";
import { MAX_AUTO_VERSIONS, isAutoTargetDuration } from "../shared/types";
import { ANGLE_NAMES, MAX_ANGLE_VERSIONS, VERSION_ANGLES } from "../shared/version-angles";
import { AUDIO_LOOKS, audioLookById, isAutoAudioNone } from "../shared/audio";
import FinishingPresets from "./FinishingPresets";
import BlackBandsEditor from "./BlackBandsEditor";
import { applyBandFinish } from "../shared/black-bands";
import PacingOptions from "./PacingOptions";
import "./pacing.css";
import "./auto-panel.css";
import { AutoViewSwitch, type AutoView } from "./QuickAutoPanel";
import AutoLengthMode from "./AutoLengthMode";

export const AUTO_FORMAT_NAMES: Record<AutoOptions["aspect"], string> = {
  "9:16": "TikTok & Reels",
  "1:1": "Square posts",
  "4:5": "Instagram feed",
  "16:9": "Landscape",
  original: "Original format",
};

export default function AutoPanel({
  watermarkControls,
  scopeDescription,
  onView,
  onSaveStyle,
  options,
  onChange,
  mixedLength,
  onLengthChange,
  capabilities,
  variants,
  onVariantsChange,
  onPromptApply,
  onPromptManual,
  onBrollSelectionChange,
  onLibraryBusyChange,
  onBrollRemoved,
  sources,
  selectedId,
  onSourceChange,
  onApplyAll,
  selectedVideos,
  onApplySelectedFootage,
  footageDisabled,
  libraryBusy,
  maxFiles,
  maxFileSize,
}: {
  watermarkControls: ReactNode;
  scopeDescription: string;
  onView?: (view: AutoView) => void;
  onSaveStyle?: () => void;
  options: AutoOptions;
  onChange: (value: AutoOptions) => void;
  mixedLength: boolean;
  onLengthChange: (mode: NonNullable<AutoOptions['durationMode']>) => void;
  capabilities: AutoCapabilities | null;
  variants: number;
  onVariantsChange: (value: number) => void;
  onPromptManual: (settings: RemixSettings) => void;
  onPromptApply: (value: { options: AutoOptions; variants: number }) => void;
  onBrollSelectionChange: (ids: string[]) => void;
  onLibraryBusyChange: (busy: boolean) => void;
  onBrollRemoved: (id: string) => void;
  sources: VideoSource[];
  selectedId?: string;
  onSourceChange: (id: string) => void;
  onApplyAll: () => void;
  selectedVideos: FootageTarget[];
  onApplySelectedFootage: (placements: NonNullable<AutoOptions['ownFootage']>) => void;
  footageDisabled: boolean;
  libraryBusy: boolean;
  maxFiles?: number;
  maxFileSize?: number;
}) {
  const formatName = AUTO_FORMAT_NAMES[options.aspect];
  const selectedSource = sources.find(source => source.id === selectedId);
  const keepOriginalCaptions = options.captions === "keep";
  const keepOriginalAudio = isAutoAudioNone(options.audio);
  const fullLength = options.durationMode === "full";
  const angles = options.versionMode === "angles";
  const maxVersions = angles ? MAX_ANGLE_VERSIONS : MAX_AUTO_VERSIONS;
  const narrationAvailable = !fullLength && !!capabilities?.narration && !keepOriginalCaptions && !keepOriginalAudio && !angles;
  const [durationInput, setDurationInput] = useState(String(options.targetDuration));
  useEffect(() => setDurationInput(String(options.targetDuration)), [options.targetDuration, selectedId]);
  const commitDuration = () => {
    const parsed = Number(durationInput);
    const duration = durationInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed))) : options.targetDuration;
    setDurationInput(String(duration));
    onChange({ ...options, targetDuration: duration });
  };
  const [versionInput, setVersionInput] = useState(String(variants));
  useEffect(() => setVersionInput(String(variants)), [variants, selectedId]);
  const commitVersions = () => {
    const parsed = Number(versionInput);
    const count = versionInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(maxVersions, Math.floor(parsed))) : variants;
    setVersionInput(String(count));
    onVariantsChange(count);
  };
  return (
    <aside className="auto-panel panel">
      <div className="panel-heading">
        <h2>
          <Sparkles size={16} />
          Auto editor
        </h2>
        {onView ? <AutoViewSwitch view="all" onView={onView} /> : <span className="auto-badge">Guided edit</span>}
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
              ? scopeDescription + ". Only changed settings are copied."
              : "Add footage when you're ready. These preferences will apply to new videos."}
          </p>
          {sources.length > 1 && (
            <button type="button" disabled={libraryBusy} onClick={onApplyAll}>
              <Copy size={14} /> Copy all Auto settings to all {sources.length} videos
            </button>
          )}
          {sources.length > 1 && (
            <small>
              Copies format, captions, sound, footage and version count to every imported video. Watermark areas stay with each video. Future imports change only when selected above.
            </small>
          )}
          {onSaveStyle && (
            <button type="button" disabled={libraryBusy} onClick={onSaveStyle}>
              <Palette size={14} /> Save this look as my style
            </button>
          )}
          {onSaveStyle && (
            <small>
              Caption look, black bands, pacing and sound, for every video in Auto and Manual.
            </small>
          )}
          {libraryBusy && (
            <small role="status">
              Finish the B-roll update before switching videos.
            </small>
          )}
        </div>
        {selectedSource && <AutoPromptEditor key={selectedSource.id} sourceId={selectedSource.id} options={options} variants={variants}
          disabled={footageDisabled || libraryBusy} onApply={onPromptApply} onSwitchManual={onPromptManual} />}
        <AutoLengthMode value={options.durationMode} mixed={mixedLength} onChange={onLengthChange} />
        <section className="auto-layout" aria-labelledby="auto-layout-title">
          <h3 id="auto-layout-title">Black bands &amp; text</h3>
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
          <BlackBandsEditor value={options.blackBands} onChange={blackBands => onChange({ ...options, blackBands })} />
        </section>
        {watermarkControls}
        <OwnFootagePanel key={selectedId || "default"} value={options.ownFootage} onChange={ownFootage => onChange({ ...options, ownFootage })} disabled={footageDisabled}
          selectedVideos={selectedVideos} onApplySelected={onApplySelectedFootage} />
        <FinishingPresets mode="auto" settings={options} disabled={libraryBusy} onApply={patch => onChange({ ...options, ...patch, blackBands: applyBandFinish(options.blackBands, patch.blackBands) })} />
        {fullLength ? <p className="auto-preferences-note">Full video keeps the original order, pauses and voice. One export is made per video; inserted footage adds to its length.</p>
          : <PacingOptions value={options.pacing} onChange={pacing => onChange({ ...options, pacing })} disabled={libraryBusy} />}
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
            <span>{fullLength ? "Full video" : `Up to ${options.targetDuration} seconds`}</span>
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
            {!fullLength && <>
            <label className="auto-output-field" data-tour="auto-length">
              Maximum excerpt length (seconds)
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
              Any whole number from 1 second. Auto may choose a shorter excerpt. Inserted footage adds to the final length.
            </p>
            <label className="auto-output-field">
              Maximum versions
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={maxVersions}
                step={1}
                value={versionInput}
                aria-describedby="auto-version-note"
                onChange={(event) => {
                  setVersionInput(event.target.value);
                  const count = event.target.valueAsNumber;
                  if (Number.isInteger(count) && count >= 1 && count <= maxVersions)
                    onVariantsChange(count);
                }}
                onBlur={commitVersions}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </label>
            <p id="auto-version-note" className="auto-preferences-note">
              {angles
                ? `1–${MAX_ANGLE_VERSIONS} per video, one for each angle.`
                : `1–${MAX_AUTO_VERSIONS} per video. Similar cuts are skipped, so you may get fewer versions.`}
            </p>
            <label className="auto-output-field" data-tour="auto-version-mode">
              What changes between versions
              <select value={angles ? "angles" : "moments"} aria-describedby="auto-version-mode-note"
                onChange={(event) => {
                  const versionMode = event.target.value === "angles" ? "angles" : "moments";
                  onChange({ ...options, versionMode });
                  if (versionMode === "angles" && variants > MAX_ANGLE_VERSIONS) onVariantsChange(MAX_ANGLE_VERSIONS);
                }}>
                <option value="moments">A different moment</option>
                <option value="angles">New angles on the same moment</option>
              </select>
            </label>
            <p id="auto-version-mode-note" className="auto-preferences-note">
              {angles
                ? `Version 1 is the ${ANGLE_NAMES.classic.toLowerCase()} edit. Later versions reuse its moment: ${VERSION_ANGLES.slice(1).map(angle => ANGLE_NAMES[angle].toLowerCase()).join(", ")}. They keep the original voice and write their on-screen text with DeepSeek.`
                : "Each version looks for a different moment in this video."}
            </p>
            </>}
            <label className="auto-output-field" data-tour="auto-captions">
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
            {options.captions !== "keep" && <CaptionAppearance value={options.captionStyle} showPreview={false} onChange={captionStyle => onChange({ ...options, captionStyle })} />}
            <label className="auto-output-field" data-tour="auto-sound">
              Sound
              <select value={keepOriginalAudio ? "off" : options.audio ?? "auto"} aria-describedby="auto-audio-note"
                onChange={(event) => onChange({ ...options, audio: event.target.value as AutoOptions["audio"],
                  ...(event.target.value === "off" ? { narration: false } : {}) })}>
                <option value="auto">Auto · measure and choose</option>
                <option value="off">None · keep original audio</option>
                {AUDIO_LOOKS.filter(look => look.id !== "original").map(look => (
                  <option key={look.id} value={look.id}>{look.name}</option>
                ))}
              </select>
            </label>
            <p id="auto-audio-note" className="auto-preferences-note">
              {keepOriginalAudio
                ? "No sound effects, loudness normalization, cut fades or replacement narration. Keeps the original voice and volume. Audio follows your video cuts."
                : options.audio && options.audio !== "auto"
                  ? `${audioLookById(options.audio)?.description} Applied to every version in this batch.`
                  : "Measures the selected speech on this computer — its noise floor, level spread and tone balance — and applies the closest-fitting sound look. Sources with no recognized speech are left untouched."}
            </p>
            <label className="auto-output-field" data-tour="auto-review">
              Editorial review
              <select value={fullLength && options.editorialMode !== "off" ? "check" : options.editorialMode ?? "repair"} onChange={(event) => onChange({ ...options, editorialMode: event.target.value as AutoOptions["editorialMode"] })}>
                <option value="repair" disabled={fullLength}>Check and repair · up to 2 attempts</option>
                <option value="check">Check only</option>
                <option value="off">Off</option>
              </select>
            </label>
            <p className="auto-preferences-note">{fullLength ? "Review checks the video without changing its cuts or timing. Full video keeps the complete original." : "DeepSeek checks the opening, meaning, and ending against the original transcript. Without usable speech, DeepSeek Flash reviews sampled source frames instead. Repair mode can try up to two speech-based corrections, keeping proposals only when the follow-up check reports fewer issues. Models can miss problems; review the finished short."}</p>
            <label className="auto-narration-toggle"><span><strong>Review finished picture &amp; sound</strong><small>Inspect sampled source/export frames and compare captions with the rendered soundtrack. Adds processing time.</small></span><input type="checkbox" checked={options.finishedReview !== false} onChange={event => onChange({ ...options, finishedReview: event.target.checked })} /></label>
            <p className="auto-preferences-note">Finished picture review sends sampled frames and recognized speech to DeepSeek. Audio transcription runs locally. Findings are advisory and never block your download.</p>
            <p className="auto-preferences-note">When available, AI selection, checks, and repairs use {capabilities?.intelligenceModel ? `DeepSeek · ${capabilities.intelligenceModel}` : "DeepSeek"}. Bounded transcript excerpts, captions, headings, and edit metadata are sent to DeepSeek. Transcription and rendering stay on this computer.</p>
            {!fullLength && <label
              className={`auto-narration-toggle ${!narrationAvailable ? "unavailable" : ""}`}
            >
              <span>
                <strong>New narration</strong>
                <small>
                  {keepOriginalAudio
                    ? "Sound is set to None, so the original voice is kept."
                    : angles
                    ? "New angles on one moment keep the original voice."
                    : keepOriginalCaptions
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
            </label>}
            <SupportingVisualsEditor options={options} onChange={patch => onChange({ ...options, ...patch })}
              capabilities={capabilities} selectedId={selectedId} libraryBusy={libraryBusy}
              onBrollSelectionChange={onBrollSelectionChange} onLibraryBusyChange={onLibraryBusyChange}
              onBrollRemoved={onBrollRemoved} maxFiles={maxFiles} maxFileSize={maxFileSize} />
          </div>
        </details>
        <div className="auto-workflow-note">
          <Scissors size={16} />
          <p>
            {fullLength ? "Auto keeps the full video and applies your caption, framing and footage preferences. You can refine the result after rendering." : capabilities?.transcription
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
            <ProblemNotice message={capabilities.message} operation="Check automatic editing tools" severity="warning" />
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
