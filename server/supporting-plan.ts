import { planGraphicScenes } from "./graphic-planner.js";
import type { GraphicScene } from "../shared/graphic-scene.js";
import { GRAPHIC_KIND_LABELS } from "../shared/graphic-scene.js";
import path from "node:path";
import type { BrollAsset, RenderJob, Transcript, VisualSource } from "../shared/types.js";
import { DEFAULT_BROLL_COUNT, MAX_BROLL_COUNT, DEFAULT_BROLL_MAX_COVERAGE } from "../shared/types.js";
import { getVisualSources, getBrollMatching, hasStockVisuals, VISUAL_SOURCE_LABELS } from "../shared/visual-sources.js";
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
  words?: Transcript["segments"][number]["words"];
  start: number;
  end: number;
  text: string;
  context?: string;
}
export interface PlannedSupportingVisual extends Moment {
  scene?: GraphicScene;
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
  effortRound = 0,
): Moment[] {
  const opening = effortRound ? 0.25 : 3.5;
  if (duration < (effortRound ? 2 : 6)) return [];
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
        const start = effortRound ? Math.max(opening, selected[0]!.start) : selected[0]!.start;
        const end = Math.min(
          duration - 0.35,
          Math.max(selected.at(-1)!.end + 0.25, start + 2.4),
          start + maximumShotDuration,
        );
        if (selected.at(-1)!.end > start && start >= opening && end - start >= 1.5)
          grouped.push({
            start,
            end,
            text: selected.map((word) => word.word.trim()).join(" "),
            context,
            words: selected,
          });
        first = last + 1;
      }
      return grouped;
    }
    const start = effortRound ? Math.max(opening, segment.start) : segment.start;
    const end = Math.min(
      duration - 0.35,
      Math.max(segment.end, start + 2.4),
      start + maximumShotDuration,
    );
    return segment.end > start && start >= opening && end - start >= 1.5
      ? [{ start, end, text: segment.text.trim(), context }]
      : [];
  });
}

/** Give explanations enough spoken context for a relationship, while stock shots
 * keep their shorter windows. Boundaries, reserved shots and coverage still win. */
function explanationMoments(base: Moment[], transcript: Transcript | undefined, duration: number, maximum: number, occupied: Pick<SupportingVisual, "start" | "end">[], gap: number): Moment[] {
  const allWords = transcript?.segments.flatMap(segment => segment.words).sort((a,b) => a.start-b.start) ?? [];
  return base.map(moment => {
    if (!moment.words?.length || !transcript) return moment;
    const nextShot = occupied.filter(shot => shot.start > moment.start).sort((a,b) => a.start-b.start)[0];
    const limit = Math.min(duration-.35, moment.start+maximum, nextShot ? nextShot.start-gap : Infinity);
    const words: NonNullable<Moment["words"]> = [];
    let lower = 0, upper = allWords.length;
    while (lower < upper) {
      const middle = Math.floor((lower+upper)/2);
      if (allWords[middle]!.start < moment.start-.001) lower = middle+1; else upper = middle;
    }
    for (let index = lower; index < allWords.length; index++) {
      const word = allWords[index]!;
      if (word.end > limit) break;
      words.push(word);
      if (words.length >= 18 || (words.length >= 5 && /[.!?。！？]$/u.test(word.word.trim()))) break;
    }
    if (!words.length) return moment;
    return { ...moment, words, text: words.map(word => word.word.trim()).join(" "),
      end: Math.min(limit, Math.max(moment.end, words.at(-1)!.end+.35)) };
  });
}

export function planSupportingVisuals({
  transcript, duration, sourceName, assets, mode = "off", visualSources, aiMatches,
  graphicScenes, graphicMoments, brollCount, brollMaxCoverage = DEFAULT_BROLL_MAX_COVERAGE, assetSources = {}, occupied = [], effortRound = 0, graphicStart = 0,
}: {
  transcript?: Transcript;
  graphicScenes?: Map<number, GraphicScene>;
  graphicMoments?: Moment[];
  duration: number;
  sourceName: string;
  assets: BrollAsset[];
  mode?: NonNullable<NonNullable<RenderJob["auto"]>["supportingVisuals"]>;
  visualSources?: VisualSource[];
  /** Undefined uses local tags. An empty AI result keeps the source picture. */
  aiMatches?: AIMatch[];
  brollCount?: number;
  brollMaxCoverage?: number;
  /** A previously downloaded stock clip can also be selected from the library. */
  assetSources?: Record<string, VisualSource>;
  effortRound?: number;
  graphicStart?: number;
  occupied?: Pick<SupportingVisual, "start" | "end">[];
}): PlannedSupportingVisual[] {
  const sources = getVisualSources({ supportingVisuals: mode, visualSources });
  if (!sources.length) return [];
  const requested = targetCount(brollCount);
  const timingCount = Math.min(MAX_BROLL_COUNT, requested + occupied.length);
  const legacyGraphics = visualSources === undefined && mode === "graphics" && brollCount === undefined;
  const maximum = legacyGraphics ? Math.min(3, Math.max(1, Math.floor(duration / 12))) : requested;
  const candidates = moments(transcript, duration, sourceName, effortRound ? 1.5 : shotDuration(duration, timingCount), effortRound)
    .filter(moment => occupied.every(shot => moment.start >= shot.end + (effortRound ? 0.15 : 0) || moment.end <= shot.start - (effortRound ? 0.15 : 0)));
  const used = new Set<string>();
  const result: PlannedSupportingVisual[] = [];
  const counts = new Map(sources.map(source => [source, 0]));
  const gap = effortRound ? 0.15 : timingCount >= 6 ? 0.6 : 1.2;
  const coverageBudget = duration * Math.min(legacyGraphics ? 30 : 100, brollMaxCoverage) / 100;
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
        const idea = graphicMoments?.[momentIndex] ?? moment;
        const text = idea.text.replace(/\s+/gu, " ").trim();
        if (!transcript?.segments.length || idea.start < graphicStart) continue;
        const scene = graphicScenes?.get(momentIndex);
        // The public timing helper can propose moments; production supplies only
        // verified scenes. Readability is based on scene labels, not speech length.
        if (graphicScenes ? !scene : text.length < 12 || text.length > 100 || tokens(text).length < 2 ||
          text.split(/\s+/u).length > Math.max(6, Math.floor((idea.end - idea.start) * 4))) continue;
        proposed = { ...idea, text, kind: "graphic", visualSource: source, scene,
          reason: scene?.reason ?? "Spoken moment available for illustration planning." };
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

async function prepareSupportingVisualsPass({
  source, job, transcript, assets, workDir, signal, onPhase, occupied = [], options = job.auto,
  inspect = inspectBrollWindows, findStock = findStockBroll, matchAI = matchBrollWithAI,
  available = graphicAvailable, render = renderCard, planGraphics = planGraphicScenes, effortRound = 0, excludedStockIds = [],
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
  planGraphics?: typeof planGraphicScenes;
  effortRound?: number;
  excludedStockIds?: string[];
}): Promise<SupportingVisual[]> {
  const selected = getVisualSources(options);
  if (!selected.length) return [];
  const duration = job.summary!.outputDuration;
  const requested = targetCount(options?.brollCount);
  const timingCount = Math.min(MAX_BROLL_COUNT, requested + occupied.length);
  const matchingMoments = moments(transcript, duration, source.name, effortRound ? 1.5 : shotDuration(duration, timingCount), effortRound)
    .filter(moment => occupied.every(shot => moment.start >= shot.end + (effortRound ? 0.15 : 0) || moment.end <= shot.start - (effortRound ? 0.15 : 0)));
  const dimensions = geometry(source, job.settings);
  const usesAI = selected.some(source => source === "pixabay" || source === "pexels" || source === "library") && getBrollMatching(options) === "ai";
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
        moments: matchingMoments, targetCount: requested, searchRound: effortRound, excludedStockIds, providers: selected.filter((source): source is "pixabay" | "pexels" => source === "pixabay" || source === "pexels"),
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
      const ai = await matchAI({ assets, moments: matchingMoments, targetCount: requested, effortRound, workDir, signal,
        onPhase: (phase) => onPhase(phase, 64) });
      aiMatches = ai.matches;
      ai.notes.forEach(addNote);
    } else if (!transcript?.segments.length)
      addNote("AI B-roll matching needs a speech transcript. Original footage was kept.");
  }
  const graphicMoments = explanationMoments(matchingMoments, transcript, duration,
    effortRound ? 3.6 : Math.max(3.6, Math.min(6, duration * (options?.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE) / 100 / timingCount)), occupied, effortRound ? .15 : timingCount >= 6 ? .6 : 1.2);
  let graphicScenes = new Map<number, GraphicScene>();
  if (sources.some(source => source === "hyperframes" || source === "remotion") && transcript?.segments.length) {
    onPhase("Designing illustrations from the spoken ideas", 64);
    const graphics = await planGraphics({ moments: graphicMoments, signal });
    graphicScenes = graphics.scenes;
    graphics.notes.forEach(addNote);
    if (!graphicScenes.size) addNote("No useful illustration fit these spoken moments. Original footage was kept.");
  }
  const plan = (candidates: StoredBroll[]) => planSupportingVisuals({
    transcript, duration, sourceName: source.name, assets: candidates,
    visualSources: sources, aiMatches, graphicScenes, graphicMoments, brollCount: requested, brollMaxCoverage: options?.brollMaxCoverage, assetSources, occupied, effortRound,
    graphicStart: job.settings.hookText ? job.settings.hookDuration : 0,
  });
  let plans = plan(assets);
  const rejected = new Set<string>();
  const verified = new Set<string>();
  while (true) {
    let changed = false;
    for (const [index, placement] of plans.entries()) {
      if (placement.kind !== "broll") continue;
      const asset = assets.find(item => item.id === placement.assetId)!;
      if (!asset.stock) continue;
      const identity = JSON.stringify([asset.id, placement.sourceStart, placement.end - placement.start]);
      if (verified.has(identity)) continue;
      onPhase(`Verifying the final B-roll interval · shot ${index + 1}/${plans.length}`, 64);
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
      if (!placement.scene) continue;
      const scene = placement.scene;
      const engines = [placement.visualSource as GraphicSource, ...sources.filter((source): source is GraphicSource =>
        (source === "hyperframes" || source === "remotion") && source !== placement.visualSource)];
      for (const engine of engines) try {
        onPhase(`Creating ${VISUAL_SOURCE_LABELS[engine]} animated card · shot ${index + 1}/${plans.length}`, 65);
        const output = path.join(workDir, `supporting-${engine}-${effortRound}-${index}.mp4`);
        await render(engine, { text: scene.title, scene, ...dimensions, duration: placement.end - placement.start,
          output, workDir, signal });
        result.push({ path: output, start: placement.start, end: placement.end, sourceStart: 0,
          label: scene.title, kind: "graphic", visualSource: engine });
        details.push({ name: scene.title, kind: "graphic", visualSource: engine, start: placement.start,
          end: placement.end, reason: placement.reason, graphicScene: scene });
        addNote(`${GRAPHIC_KIND_LABELS[scene.kind]} at ${placement.start.toFixed(1)}s: ${scene.title} — ${scene.reason}`);
        break;
      } catch {
        signal.throwIfAborted();
        addNote(`A ${VISUAL_SOURCE_LABELS[engine]} animated card could not be rendered. Other selected renderers and later placements were tried.`);
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

/** Fulfil the requested total through up to three complementary passes. Successful
 * placements stay fixed; retries use shorter slots and additional stock pages.
 * Relevance and motion checks never weaken to satisfy the count. */
export async function prepareSupportingVisuals(input: Parameters<typeof prepareSupportingVisualsPass>[0]): Promise<SupportingVisual[]> {
  const options = input.options ?? input.job.auto;
  if (!getVisualSources(options).length) return [];
  input.job.visualSearch = { startedAt: new Date().toISOString(), budgetMs: 480_000, pass: 1, maxPasses: 3,
    requested: targetCount(options?.brollCount), placed: 0 };
  try { return await prepareSupportingVisualsWithProgress(input); }
  finally { delete input.job.visualSearch; }
}

async function prepareSupportingVisualsWithProgress(input: Parameters<typeof prepareSupportingVisualsPass>[0]): Promise<SupportingVisual[]> {
  const options = input.options ?? input.job.auto;
  if (!getVisualSources(options).length) return [];
  // Upgrade old saved/retried stock jobs as well as newly validated requests.
  if (input.job.auto && hasStockVisuals(options)) input.job.auto.brollMatching = "ai";
  const requested = targetCount(options?.brollCount);
  const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(input.job.visualSearch!.budgetMs)]);
  const result: SupportingVisual[] = [];
  const details: NonNullable<StoredJob["supportingVisuals"]> = [];
  const candidates = new Map<string, StoredBroll>();
  const usedIds = new Set<string>();
  const usedStock = new Set(input.excludedStockIds ?? []);
  const baseChanges = [...input.job.summary!.changes];
  const baseCallouts = structuredClone(input.job.settings.callouts);
  let attempts = 0;
  for (let round = 0; round < 3 && result.length < requested; round++) {
    input.signal.throwIfAborted();
    if (deadline.aborted) break;
    const budget = input.job.summary!.outputDuration * (options?.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE) / 100;
    const covered = [...(input.occupied ?? []), ...result].reduce((sum, shot) => sum + shot.end - shot.start, 0);
    if (budget - covered < 1.5 - 1e-9) break;
    attempts++;
    input.job.visualSearch!.pass = round + 1;
    input.job.visualSearch!.placed = result.length;
    input.onPhase(`Filling supporting visuals: ${result.length}/${requested} · pass ${round + 1}/3`, 62);
    input.job.summary!.changes = [...baseChanges];
    input.job.settings.callouts = structuredClone(baseCallouts);
    // Existing library files may be tried again, but a chosen clip is never repeated.
    try {
      const extra = await prepareSupportingVisualsPass({ ...input, signal: deadline, effortRound: round,
        options: { ...options!, brollCount: requested - result.length },
        assets: input.assets.filter(asset => !usedIds.has(asset.id)),
        occupied: [...(input.occupied ?? []), ...result], excludedStockIds: [...usedStock] });
      result.push(...extra);
      input.job.visualSearch!.placed = result.length;
      details.push(...(input.job.supportingVisuals ?? []));
      for (const asset of input.job.brollCandidates ?? []) candidates.set(asset.id, asset);
      for (const detail of details) {
        if (detail.assetId) usedIds.add(detail.assetId);
        if (detail.stock?.providerId) usedStock.add(detail.stock.providerId);
      }
    } catch (error) {
      input.signal.throwIfAborted();
      if (!deadline.aborted) throw error;
      break;
    }
  }
  input.job.supportingVisuals = details.sort((a, b) => a.start - b.start);
  // Keep all used media ahead of optional alternatives in the retained pool.
  input.job.brollCandidates = [...candidates.values()].sort((a,b) => Number(usedIds.has(b.id)) - Number(usedIds.has(a.id))).slice(0, 40);
  input.job.summary!.changes = baseChanges;
  input.job.settings.callouts = baseCallouts;
  removeGraphicCalloutOverlaps(input.job, result);
  const stock = details.filter(item => item.kind === "broll").length, cards = details.length - stock;
  if (stock) input.job.summary!.changes.push(`${stock} B-roll cutaway${stock === 1 ? "" : "s"}`);
  if (cards) input.job.summary!.changes.push(`${cards} animated card${cards === 1 ? "" : "s"}`);
  if (stock && getBrollMatching(options) === "ai") { input.job.summary!.changes.push("AI visual matching"); input.job.summary!.usedAI = true; }
  input.job.notes = (input.job.notes ?? []).filter(note => !/^(?:B-roll target:|Supporting visual target:|Visual mix —)/u.test(note));
  if (result.length) input.job.notes = input.job.notes.filter(note => !/^No (?:suitable|relevant)|^AI found no spoken moment|^None of the /u.test(note));
  const reason = result.length < requested ? (deadline.aborted ? "The eight-minute search/render budget was reached."
    : "Available matching footage, readable spoken phrases, working renderers or timeline space within the coverage limit could not fill the remaining places.") : undefined;
  input.job.notes.push(`Supporting visual coverage limit: ${options?.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE}% of the video, across all search passes.`);
  input.job.notes.push(`Supporting visual target: ${result.length} of ${requested} shots added after ${attempts} pass${attempts === 1 ? "" : "es"}.${reason ? ` ${reason}` : ""}`);
  input.job.visualFulfillment = { requested, placed: result.length, attempts, ...(reason ? { reason } : {}) };
  const selected = getVisualSources(options);
  if (selected.length > 1) input.job.notes.push(`Visual mix — ${selected.map(source => `${VISUAL_SOURCE_LABELS[source]}: ${details.filter(item => item.visualSource === source).length}`).join(" · ")}.`);
  input.job.notes = compactBrollNotes(input.job.notes);
  return result.sort((a,b) => a.start - b.start);
}
