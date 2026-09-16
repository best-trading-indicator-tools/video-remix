import path from "node:path";
import type { BrollAsset, RenderJob, Transcript, VisualSource } from "../shared/types.js";
import { DEFAULT_BROLL_COUNT, MAX_BROLL_COUNT } from "../shared/types.js";
import { getVisualSources, VISUAL_SOURCE_LABELS } from "../shared/visual-sources.js";
import { geometry } from "./engine.js";
import {
  graphicsAvailable,
  renderGraphic,
  type SupportingVisual,
  type GraphicOptions,
} from "./visuals.js";
import type { StoredBroll, StoredJob, StoredSource } from "./store.js";
import { matchBrollWithAI } from "./broll-ai.js";

import { brollTokens as tokens } from "./broll-text.js";
import { findStockBroll } from "./stock-broll.js";
import { inspectBrollWindows } from "./broll-motion.js";
import { compactBrollNotes } from "../shared/broll-notes.js";

interface Moment {
  start: number;
  end: number;
  text: string;
  context?: string;
}
export interface PlannedSupportingVisual extends Moment {
  assetId?: string;
  kind: "broll" | "graphic";
  visualSource: VisualSource;
  sourceStart?: number;
  reason?: string;
}
interface AIMatch {
  momentIndex: number;
  assetId: string;
  sourceStart: number;
  reason: string;
}
const targetCount = (count = DEFAULT_BROLL_COUNT) => Number.isInteger(count)
  ? Math.max(1, Math.min(MAX_BROLL_COUNT, count)) : DEFAULT_BROLL_COUNT;
const shotDuration = (duration: number, count: number) => Math.max(1.5, Math.min(3.6, duration * 0.6 / count));

function moments(
  transcript: Transcript | undefined,
  duration: number,
  sourceName: string,
  maximumShotDuration = 3.6,
): Moment[] {
  if (duration < 6) return [];
  if (!transcript?.segments.length)
    return [
      {
        start: Math.min(4, duration * 0.4),
        end: Math.min(duration - 0.4, Math.min(4, duration * 0.4) + 3),
        text: path.parse(sourceName).name,
      },
    ];
  return transcript.segments.flatMap((segment, segmentIndex) => {
    if (!segment.text.trim()) return [];
    const context = transcript.segments.slice(Math.max(0, segmentIndex - 1), segmentIndex + 2)
      .map(item => item.text).join(" ").slice(0, 1500);
    // A supporting shot starts with an actual spoken phrase, never at an
    // unrelated percentage of the running time.
    if (segment.words.length) {
      const grouped: Moment[] = [];
      let first = 0;
      while (first < segment.words.length) {
        let last = first;
        while (
          last + 1 < segment.words.length &&
          last - first < 7 &&
          segment.words[last + 1]!.end - segment.words[first]!.start <= maximumShotDuration &&
          !/[.!?。！？]$/u.test(segment.words[last]!.word)
        )
          last++;
        const selected = segment.words.slice(first, last + 1);
        const start = selected[0]!.start;
        const end = Math.min(
          duration - 0.35,
          Math.max(selected.at(-1)!.end + 0.25, start + 2.4),
          start + maximumShotDuration,
        );
        if (start >= 3.5 && end - start >= 1.5)
          grouped.push({
            start,
            end,
            text: selected.map((word) => word.word.trim()).join(" "),
            context,
          });
        first = last + 1;
      }
      return grouped;
    }
    const start = segment.start;
    const end = Math.min(
      duration - 0.35,
      Math.max(segment.end, start + 2.4),
      start + maximumShotDuration,
    );
    return start >= 3.5 && end - start >= 1.5
      ? [{ start, end, text: segment.text.trim(), context }]
      : [];
  });
}

export function planSupportingVisuals({
  transcript, duration, sourceName, assets, mode = "off", visualSources, aiMatches,
  brollCount, assetSources = {}, occupied = [],
}: {
  transcript?: Transcript;
  duration: number;
  sourceName: string;
  assets: BrollAsset[];
  mode?: NonNullable<NonNullable<RenderJob["auto"]>["supportingVisuals"]>;
  visualSources?: VisualSource[];
  /** Undefined uses local tags. An empty AI result keeps the source picture. */
  aiMatches?: AIMatch[];
  brollCount?: number;
  /** A previously downloaded stock clip can also be selected from the library. */
  assetSources?: Record<string, VisualSource>;
  occupied?: Pick<SupportingVisual, "start" | "end">[];
}): PlannedSupportingVisual[] {
  const sources = getVisualSources({ supportingVisuals: mode, visualSources });
  if (!sources.length) return [];
  const requested = targetCount(brollCount);
  const timingCount = Math.min(MAX_BROLL_COUNT, requested + occupied.length);
  const legacyGraphics = visualSources === undefined && mode === "graphics";
  const maximum = legacyGraphics ? Math.min(3, Math.max(1, Math.floor(duration / 12))) : requested;
  const candidates = moments(transcript, duration, sourceName, shotDuration(duration, timingCount));
  const used = new Set<string>();
  const result: PlannedSupportingVisual[] = [];
  const counts = new Map(sources.map(source => [source, 0]));
  const gap = timingCount >= 6 ? 0.6 : 1.2;
  const coverageBudget = duration * (legacyGraphics ? 0.3 : 0.6);
  const fits = (moment: Moment) => [...occupied, ...result].every(other =>
    moment.start >= other.end + gap - 1e-9 || moment.end + gap <= other.start + 1e-9) &&
    [...occupied, ...result].reduce((sum, item) => sum + item.end - item.start, 0) +
      moment.end - moment.start <= coverageBudget + 1e-9;
  const origin = (asset: BrollAsset): VisualSource => assetSources[asset.id] ??
    (visualSources === undefined && mode === "library" ? "library" :
      asset.stock?.providerId.startsWith("pexels:") || asset.attribution?.provider === "Pexels" ? "pexels" : asset.stock || asset.attribution?.provider === "Pixabay" ? "pixabay" : "library");

  for (const [momentIndex, moment] of candidates.entries()) {
    if (result.length >= maximum) break;
    // Underrepresented sources get the next chance. If one has no relevant
    // shot at this moment, another selected source can still fill the slot.
    const priority = [...sources].sort((a, b) => counts.get(a)! - counts.get(b)!);
    for (const source of priority) {
      let proposed: PlannedSupportingVisual | undefined;
      if (source === "hyperframes" || source === "remotion") {
        const text = moment.text.replace(/\s+/gu, " ").trim();
        if (!transcript?.segments.length || text.length < 12 || text.length > 100 || tokens(text).length < 2)
          continue;
        proposed = { ...moment, text, kind: "graphic", visualSource: source,
          reason: "Animated emphasis of the spoken phrase." };
      } else {
        const words = new Set(tokens(moment.text));
        const available = assets.filter(asset => origin(asset) === source && !used.has(asset.id) && asset.duration >= 1.5);
        const ranked = aiMatches === undefined
          ? available.map(asset => ({ asset, sourceStart: asset.selection?.sourceStart ?? 0,
              score: tokens(`${path.parse(asset.name).name} ${asset.tags.join(" ")}`).filter(word => words.has(word)).length,
              reason: undefined as string | undefined }))
            .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id))
          : aiMatches.filter(match => match.momentIndex === momentIndex).flatMap(match => {
              const asset = available.find(item => item.id === match.assetId);
              return asset ? [{ asset, sourceStart: match.sourceStart, score: 1, reason: match.reason }] : [];
            });
        for (const { asset, sourceStart, reason } of ranked) {
          if (!Number.isFinite(sourceStart) || sourceStart < 0 || asset.duration - sourceStart < 1.5) continue;
          const end = Math.min(moment.end, moment.start + asset.duration - sourceStart,
            moment.start + shotDuration(duration, timingCount), moment.start + (asset.selection?.duration ?? 3.6));
          if (end - moment.start < 1.5 || !fits({ ...moment, end })) continue;
          proposed = { ...moment, end, assetId: asset.id, kind: "broll", visualSource: source, sourceStart,
            ...(reason ? { reason } : {}) };
          break;
        }
      }
      if (!proposed || !fits(proposed)) continue;
      result.push(proposed);
      if (proposed.assetId) used.add(proposed.assetId);
      counts.set(source, counts.get(source)! + 1);
      break;
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

/** Keep motion-card headlines clear; hooks and spoken captions are separate. */
export function removeGraphicCalloutOverlaps(
  job: Pick<RenderJob, "settings" | "summary">,
  renderedVisuals: Pick<SupportingVisual, "kind" | "start" | "end">[],
): void {
  if (!job.settings.callouts?.length) return;
  const graphics = renderedVisuals.filter(
    (visual) => visual.kind === "graphic",
  );
  job.settings.callouts = job.settings.callouts.filter(
    (callout) =>
      !graphics.some(
        (graphic) => callout.start < graphic.end && graphic.start < callout.end,
      ),
  );
  // Intervals are half-open in FFmpeg: ending when a card starts (or starting
  // when it ends) is safe. Only successfully rendered cards suppress callouts.
  if (!job.settings.callouts.length && job.summary)
    job.summary.changes = job.summary.changes.filter(
      (change) => change !== "Key-point overlays",
    );
}

type GraphicSource = "hyperframes" | "remotion";
const graphicAvailable = async (source: GraphicSource) => source === "hyperframes"
  ? graphicsAvailable() : (await import("./remotion-visuals.js")).remotionAvailable();
const renderCard = async (source: GraphicSource, options: GraphicOptions) => source === "hyperframes"
  ? renderGraphic(options) : (await import("./remotion-visuals.js")).renderRemotionGraphic(options);

export async function prepareSupportingVisuals({
  source, job, transcript, assets, workDir, signal, onPhase, occupied = [], options = job.auto,
  inspect = inspectBrollWindows, findStock = findStockBroll, matchAI = matchBrollWithAI,
  available = graphicAvailable, render = renderCard,
}: {
  source: StoredSource;
  options?: StoredJob["auto"];
  job: StoredJob;
  transcript?: Transcript;
  assets: StoredBroll[];
  workDir: string;
  signal: AbortSignal;
  onPhase: (phase: string, progress: number) => void;
  occupied?: Pick<SupportingVisual, "start" | "end">[];
  inspect?: typeof inspectBrollWindows;
  findStock?: typeof findStockBroll;
  matchAI?: typeof matchBrollWithAI;
  available?: typeof graphicAvailable;
  render?: typeof renderCard;
}): Promise<SupportingVisual[]> {
  const selected = getVisualSources(options);
  if (!selected.length) return [];
  const duration = job.summary!.outputDuration;
  const requested = targetCount(options?.brollCount);
  const timingCount = Math.min(MAX_BROLL_COUNT, requested + occupied.length);
  const matchingMoments = moments(transcript, duration, source.name, shotDuration(duration, timingCount));
  const dimensions = geometry(source, job.settings);
  const usesAI = selected.some(source => source === "pixabay" || source === "pexels" || source === "library") && options?.brollMatching === "ai";
  const addNote = (text: string) => {
    job.notes ??= [];
    if (!job.notes.includes(text)) job.notes.push(text);
  };
  const sources: VisualSource[] = [];
  for (const selectedSource of selected) {
    signal.throwIfAborted();
    if ((selectedSource === "hyperframes" || selectedSource === "remotion") && !(await available(selectedSource))) {
      addNote(`${VISUAL_SOURCE_LABELS[selectedSource]} is unavailable on this server. Its animated cards were skipped.`);
    } else sources.push(selectedSource);
  }
  const assetSources: Record<string, VisualSource> = {};
  assets = selected.includes("library") ? [...assets] : [];
  for (const asset of assets) assetSources[asset.id] = "library";
  if (selected.includes("library") && !assets.length)
    addNote("No library clips were selected. Other selected visual sources were still tried.");
  if (selected.includes("pixabay") || selected.includes("pexels")) {
    if (usesAI && !transcript?.segments.length) {
      addNote("AI stock search needs a speech transcript. Original footage was kept.");
    } else {
      const stock = await findStock({
        moments: matchingMoments, targetCount: requested, providers: selected.filter((source): source is "pixabay" | "pexels" => source === "pixabay" || source === "pexels"),
        type: options?.stockVideoType || "all", language: transcript?.language,
        matching: usesAI ? "ai" : "tags", targetAspect: dimensions.width / dimensions.height,
        workDir, signal, onPhase: (phase) => onPhase(phase, 62),
      });
      for (const asset of stock.assets) {
        if (!assets.some(existing => existing.id === asset.id)) {
          assets.push(asset);
          assetSources[asset.id] = asset.stock?.providerId.startsWith("pexels:") ? "pexels" : "pixabay";
        }
      }
      stock.notes.forEach(addNote);
    }
  }
  let aiMatches: AIMatch[] | undefined;
  if (usesAI) {
    aiMatches = [];
    if (transcript?.segments.length && assets.length) {
      const ai = await matchAI({ assets, moments: matchingMoments, targetCount: requested, workDir, signal,
        onPhase: (phase) => onPhase(phase, 64) });
      aiMatches = ai.matches;
      ai.notes.forEach(addNote);
    } else if (!transcript?.segments.length)
      addNote("AI B-roll matching needs a speech transcript. Original footage was kept.");
  }
  const plan = (candidates: StoredBroll[]) => planSupportingVisuals({
    transcript, duration, sourceName: source.name, assets: candidates,
    visualSources: sources, aiMatches, brollCount: requested, assetSources, occupied,
  });
  let plans = plan(assets);
  const rejected = new Set<string>();
  const verified = new Set<string>();
  while (true) {
    let changed = false;
    for (const placement of plans) {
      if (placement.kind !== "broll") continue;
      const asset = assets.find(item => item.id === placement.assetId)!;
      if (!asset.stock) continue;
      const identity = JSON.stringify([asset.id, placement.sourceStart, placement.end - placement.start]);
      if (verified.has(identity)) continue;
      const checked = await inspect(asset, dimensions.width / dimensions.height, signal,
        { sourceStart: placement.sourceStart ?? 0, duration: placement.end - placement.start });
      if (checked.length) verified.add(identity);
      else { rejected.add(asset.id); changed = true; }
    }
    if (!changed) break;
    addNote("A stock shot had insufficient motion in its final interval. Other matched shots were tried.");
    plans = plan(assets.filter(asset => !rejected.has(asset.id)));
  }
  if (selected.some(source => source === "pixabay" || source === "pexels" || source === "library")) job.brollCandidates = assets.slice(0, 40);
  const result: SupportingVisual[] = [];
  const details: NonNullable<RenderJob["supportingVisuals"]> = [];
  for (const [index, placement] of plans.entries()) {
    signal.throwIfAborted();
    if (placement.kind === "broll") {
      const asset = assets.find((item) => item.id === placement.assetId)!;
      result.push({ path: asset.filePath, start: placement.start, end: placement.end,
        sourceStart: placement.sourceStart ?? 0, label: asset.name, kind: "broll", visualSource: placement.visualSource });
      details.push({ name: asset.name, kind: "broll", visualSource: placement.visualSource,
        start: placement.start, end: placement.end, assetId: asset.id,
        ...(asset.attribution ? { attribution: asset.attribution } : {}), sourceStart: placement.sourceStart ?? 0,
        ...(placement.reason ? { reason: placement.reason } : {}),
        ...(asset.selection ? { selection: asset.selection } : {}), ...(asset.stock ? { stock: asset.stock } : {}) });
      if (placement.reason) addNote(`B-roll at ${placement.start.toFixed(1)}s: ${asset.name} — ${placement.reason}`);
    } else {
      const engine = placement.visualSource as GraphicSource;
      try {
        onPhase(`Creating ${VISUAL_SOURCE_LABELS[engine]} animated cards`, 65);
        const output = path.join(workDir, `supporting-${engine}-${index}.mp4`);
        await render(engine, { text: placement.text, ...dimensions, duration: placement.end - placement.start,
          output, workDir, signal });
        result.push({ path: output, start: placement.start, end: placement.end, sourceStart: 0,
          label: placement.text, kind: "graphic", visualSource: engine });
        details.push({ name: placement.text, kind: "graphic", visualSource: engine, start: placement.start,
          end: placement.end, reason: placement.reason });
      } catch {
        signal.throwIfAborted();
        addNote(`A ${VISUAL_SOURCE_LABELS[engine]} animated card could not be rendered. The original footage was kept for that moment.`);
      }
    }
  }
  removeGraphicCalloutOverlaps(job, result);
  const footageCount = details.filter((item) => item.kind === "broll").length;
  const cardCount = details.filter((item) => item.kind === "graphic").length;
  const includesGraphics = selected.some(source => source === "hyperframes" || source === "remotion");
  const achieved = includesGraphics ? details.length : footageCount;
  addNote(`${includesGraphics ? "Supporting visual" : "B-roll"} target: ${achieved} of ${requested} shots added.${achieved < requested ? " Fewer suitable shots fit the spoken moments and timing." : ""}`);
  if (footageCount) job.summary!.changes.push(`${footageCount} B-roll cutaway${footageCount === 1 ? "" : "s"}`);
  if (footageCount && usesAI) { job.summary!.changes.push("AI visual matching"); job.summary!.usedAI = true; }
  if (cardCount) job.summary!.changes.push(`${cardCount} animated card${cardCount === 1 ? "" : "s"}`);
  if (selected.length > 1) {
    const breakdown = selected.map(source => `${VISUAL_SOURCE_LABELS[source]}: ${details.filter(item => item.visualSource === source).length}`).join(" · ");
    addNote(`Visual mix — ${breakdown}.`);
  }
  if (selected.some(source => source === "pixabay" || source === "pexels" || source === "library") && !footageCount)
    addNote(cardCount ? "No suitable stock or library footage fit this edit. Selected animated cards were used."
      : usesAI ? "No suitable AI B-roll match fit this edit. Original footage was kept."
      : "No relevant B-roll was found for this edit. Original footage was kept.");
  if (includesGraphics && !cardCount && !plans.some(placement => placement.kind === "graphic"))
    addNote(footageCount ? "No animated card fit the available spoken phrases and timing."
      : "No suitable spoken phrase or available renderer was found for an animated card. Original footage was kept.");
  job.supportingVisuals = details;
  if (job.notes) job.notes = compactBrollNotes(job.notes);
  return result;
}
