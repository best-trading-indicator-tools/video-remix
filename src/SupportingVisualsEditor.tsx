import { useEffect, useId, useState } from "react";
import { Film, FolderOpen, Layers3, Shapes } from "lucide-react";
import type { AutoCapabilities, SupportingVisualOptions, VisualSource } from "../shared/types";
import { DEFAULT_BROLL_COUNT, DEFAULT_BROLL_MAX_COVERAGE, MAX_BROLL_COUNT } from "../shared/types";
import { getVisualSources, getBrollMatching, hasGraphicVisuals, hasLibraryVisuals, hasStockVisuals, VISUAL_SOURCE_LABELS } from "../shared/visual-sources";
import BrollPanel from "./BrollPanel";
import "./auto-panel.css";

export default function SupportingVisualsEditor({ options, onChange, capabilities, selectedId, libraryBusy,
  onBrollSelectionChange, onLibraryBusyChange, onBrollRemoved, maxFiles, maxFileSize }: {
  options: SupportingVisualOptions;
  onChange: (patch: Partial<SupportingVisualOptions>) => void;
  capabilities: AutoCapabilities | null;
  selectedId?: string;
  libraryBusy: boolean;
  onBrollSelectionChange: (ids: string[]) => void;
  onLibraryBusyChange: (busy: boolean) => void;
  onBrollRemoved: (id: string) => void;
  maxFiles?: number;
  maxFileSize?: number;
}) {
  const prefix = useId();
  const visualSources = getVisualSources(options);
  const stockSelected = hasStockVisuals(options);
  const aiMatching = getBrollMatching(options) === "ai";
  const librarySelected = hasLibraryVisuals(options);
  const graphicsSelected = hasGraphicVisuals(options);
  const visualChoices: { id: VisualSource; description: string; icon: typeof Film; available: boolean; setup: string }[] = [
    { id: "pixabay", description: "Moving stock footage", icon: Film, available: capabilities?.stockProviders?.includes("pixabay") ?? !!capabilities?.stockBroll, setup: "Add a Pixabay API key in Settings to enable stock search." },
    { id: "pexels", description: "Moving stock footage", icon: Film, available: !!capabilities?.stockProviders?.includes("pexels"), setup: "Add a Pexels API key in Settings to enable stock search." },
    { id: "hyperframes", description: "Illustrated explainers", icon: Layers3, available: !!capabilities?.motionGraphics, setup: "HyperFrames renderer is unavailable on this engine." },
    { id: "remotion", description: "Illustrated explainers", icon: Shapes, available: !!capabilities?.remotionGraphics, setup: "Remotion renderer is unavailable on this engine." },
    { id: "library", description: "Your uploaded clips", icon: FolderOpen, available: true, setup: "" },
  ];
  const toggleVisualSource = (source: VisualSource, enabled: boolean) => onChange({
    visualSources: enabled ? [...visualSources, source] : visualSources.filter((item) => item !== source),
    ...((source === "pixabay" || source === "pexels") && enabled
      ? { brollMatching: "ai" as const } : {}),
  });
  const brollCount = options.brollCount ?? DEFAULT_BROLL_COUNT;
  const coverage = options.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE;
  const [coverageInput, setCoverageInput] = useState(String(coverage));
  useEffect(() => setCoverageInput(String(coverage)), [coverage, selectedId]);
  const [brollCountInput, setBrollCountInput] = useState(String(brollCount));
  useEffect(() => setBrollCountInput(String(brollCount)), [brollCount, selectedId]);
  const commitBrollCount = () => {
    const parsed = Number(brollCountInput);
    const count = brollCountInput.trim() && Number.isFinite(parsed)
      ? Math.max(1, Math.min(MAX_BROLL_COUNT, Math.floor(parsed))) : brollCount;
    setBrollCountInput(String(count));
    onChange({ brollCount: count });
  };
  return (
    <div className="supporting-visuals" data-tour="supporting-visuals">
      <fieldset className="auto-visual-sources" disabled={libraryBusy} aria-describedby={`${prefix}-auto-visual-sources-note`}>
        <legend>Supporting visuals</legend>
        <p id={`${prefix}-auto-visual-sources-note`} className="auto-preferences-note">Choose any combination of automatic supporting shots. Clips in “Add my own footage” are controlled separately.</p>
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
        {visualSources.length > 0 ? <button type="button" className="auto-visual-clear" onClick={() => onChange({ visualSources: [] })}>Turn off automatic supporting shots</button>
          : <p className="auto-visual-empty">Automatic supporting shots are off.</p>}
      </fieldset>
      <p className="auto-preferences-note">Stock videos provided by <a href="https://www.pexels.com" target="_blank" rel="noreferrer">Pexels</a> and <a href="https://pixabay.com" target="_blank" rel="noreferrer">Pixabay</a>. Creator credits accompany each selected clip.</p>
      {graphicsSelected && !capabilities?.intelligence && <p className="auto-preferences-note">Configure DeepSeek to plan illustrated explainers. Without it, the original picture is kept.</p>}
      {graphicsSelected && <p className="auto-preferences-note">DeepSeek designs illustrations, diagrams and comparisons for the current spoken idea. Charts use only numbers stated in the speech. Both renderers animate them locally; your main audio continues underneath.</p>}
      {stockSelected && (
        <div className="broll-matching">
          <label htmlFor={`${prefix}-stock-video-type`}>Stock video style</label>
          <select
            id={`${prefix}-stock-video-type`}
            value={options.stockVideoType || "all"}
            onChange={(event) =>
              onChange({
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
          {!capabilities?.stockBroll && <p className="auto-preferences-note" role="status">Add a free Pixabay or Pexels API key in Settings to enable stock search.</p>}
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
                aria-describedby={`${prefix}-auto-broll-count-note`}
                onChange={(event) => {
                  setBrollCountInput(event.target.value);
                  const count = event.target.valueAsNumber;
                  if (Number.isInteger(count) && count >= 1 && count <= MAX_BROLL_COUNT)
                    onChange({ brollCount: count });
                }}
                onBlur={commitBrollCount}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </label>
            <label className="auto-output-field">Maximum B-roll coverage (%)
              <input type="number" inputMode="numeric" min={0} max={100} step={1} value={coverageInput}
                onChange={event => { setCoverageInput(event.target.value); const n = event.target.valueAsNumber; if (Number.isInteger(n) && n >= 0 && n <= 100) onChange({ brollMaxCoverage: n }); }}
                onBlur={() => { const n = coverageInput.trim() ? Number(coverageInput) : coverage; const limit = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : coverage; setCoverageInput(String(limit)); onChange({ brollMaxCoverage: limit }); }} />
            </label>
            <p className="auto-preferences-note">Stock, uploaded B-roll and animation cards together can cover at most {coverage}% of the result. A 30-second video allows {(30 * coverage / 100).toFixed(1)} seconds. We may use fewer shots to respect this limit.</p>
            <p id={`${prefix}-auto-broll-count-note`} className="auto-preferences-note">
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
            <label htmlFor={`${prefix}-broll-matching`}>Match B-roll using</label>
            <select
              id={`${prefix}-broll-matching`}
              value={getBrollMatching(options)}
              onChange={(event) =>
                onChange({
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
                  : "Add a DeepSeek API key in Settings to enable AI matching."}
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
  );
}
