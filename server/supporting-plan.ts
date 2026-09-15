import path from "node:path";
import type { BrollAsset, RenderJob, Transcript } from "../shared/types.js";
import { geometry } from "./engine.js";
import {
  graphicsAvailable,
  renderGraphic,
  type SupportingVisual,
} from "./visuals.js";
import type { StoredBroll, StoredJob, StoredSource } from "./store.js";
import { matchBrollWithAI } from "./broll-ai.js";

import { brollTokens as tokens } from "./broll-text.js";
import { findStockBroll } from "./stock-broll.js";
import { inspectBrollWindows } from "./broll-motion.js";

interface Moment {
  start: number;
  end: number;
  text: string;
  context?: string;
}
export interface PlannedSupportingVisual extends Moment {
  assetId?: string;
  kind: "broll" | "graphic";
  sourceStart?: number;
  reason?: string;
}
interface AIMatch {
  momentIndex: number;
  assetId: string;
  sourceStart: number;
  reason: string;
}

function moments(
  transcript: Transcript | undefined,
  duration: number,
  sourceName: string,
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
          segment.words[last + 1]!.end - segment.words[first]!.start <= 3.6 &&
          !/[.!?。！？]$/u.test(segment.words[last]!.word)
        )
          last++;
        const selected = segment.words.slice(first, last + 1);
        const start = selected[0]!.start;
        const end = Math.min(
          duration - 0.35,
          Math.max(selected.at(-1)!.end + 0.25, start + 2.4),
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
      start + 3.6,
    );
    return start >= 3.5 && end - start >= 1.5
      ? [{ start, end, text: segment.text.trim(), context }]
      : [];
  });
}

export function planSupportingVisuals({
  transcript,
  duration,
  sourceName,
  assets,
  mode,
  aiMatches,
}: {
  transcript?: Transcript;
  duration: number;
  sourceName: string;
  assets: BrollAsset[];
  mode: NonNullable<NonNullable<RenderJob["auto"]>["supportingVisuals"]>;
  /** Undefined uses local tags. An empty AI result keeps the source picture. */
  aiMatches?: AIMatch[];
}): PlannedSupportingVisual[] {
  if (mode === "off") return [];
  const candidates = moments(transcript, duration, sourceName);
  const used = new Set<string>();
  const result: PlannedSupportingVisual[] = [];
  const maximum = Math.min(3, Math.max(1, Math.floor(duration / 12)));
  const coverageBudget = duration * 0.3;
  const fits = (moment: Moment) =>
    result.every(
      (other) =>
        moment.start >= other.end + 1.2 || moment.end + 1.2 <= other.start,
    ) &&
    result.reduce((sum, item) => sum + item.end - item.start, 0) +
      moment.end -
      moment.start <=
      coverageBudget;
  if (mode === "stock" || mode === "library" || mode === "both") {
    for (const [momentIndex, moment] of candidates.entries()) {
      if (result.length >= maximum) break;
      const aiMatch = aiMatches?.find(
        (match) => match.momentIndex === momentIndex,
      );
      const words = new Set(tokens(moment.text));
      const ranked = assets
        .filter((asset) => !used.has(asset.id) && asset.duration >= 1.5)
        .map((asset) => ({
          asset,
          score: tokens(
            `${path.parse(asset.name).name} ${asset.tags.join(" ")}`,
          ).filter((word) => words.has(word)).length,
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id),
        );
      const asset =
        aiMatches === undefined
          ? ranked[0]?.asset
          : assets.find((item) => item.id === aiMatch?.assetId);
      const sourceStart = aiMatches === undefined ? asset?.selection?.sourceStart ?? 0 : aiMatch?.sourceStart;
      if (
        !asset ||
        used.has(asset.id) ||
        sourceStart === undefined ||
        !Number.isFinite(sourceStart) ||
        sourceStart < 0 ||
        asset.duration - sourceStart < 1.5
      )
        continue;
      const proposed = {
        ...moment,
        end: Math.min(
          moment.end,
          moment.start + asset.duration - sourceStart,
          moment.start + 3.6,
          moment.start + (asset.selection?.duration ?? 3.6),
        ),
      };
      if (!fits(proposed)) continue;
      result.push({
        ...proposed,
        assetId: asset.id,
        ...(asset.attribution ? { attribution: asset.attribution } : {}),
        kind: "broll",
        sourceStart,
        ...(aiMatch ? { reason: aiMatch.reason } : {}),
      });
      used.add(asset.id);
    }
  }
  if ((mode === "graphics" || mode === "both") && transcript?.segments.length) {
    for (const moment of candidates) {
      if (result.length >= maximum) break;
      const text = moment.text.replace(/\s+/gu, " ").trim();
      if (
        text.length < 12 ||
        text.length > 100 ||
        tokens(text).length < 2 ||
        !fits(moment)
      )
        continue;
      result.push({ ...moment, text, kind: "graphic" });
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

export async function prepareSupportingVisuals({
  source,
  job,
  transcript,
  assets,
  workDir,
  signal,
  onPhase,
}: {
  source: StoredSource;
  job: StoredJob;
  transcript?: Transcript;
  assets: StoredBroll[];
  workDir: string;
  signal: AbortSignal;
  onPhase: (phase: string, progress: number) => void;
}): Promise<SupportingVisual[]> {
  const mode = job.auto?.supportingVisuals || "off";
  if (mode === "off") return [];
  const duration = job.summary!.outputDuration;
  const dimensions = geometry(source, job.settings);
  const usesAI =
    (mode === "stock" || mode === "library" || mode === "both") &&
    job.auto?.brollMatching === "ai";
  const addNote = (text: string) => {
    job.notes ??= [];
    if (!job.notes.includes(text)) job.notes.push(text);
  };
  if (mode === "stock") {
    if (usesAI && !transcript?.segments.length) {
      addNote("AI stock search needs a speech transcript. Original footage was kept.");
      job.supportingVisuals = [];
      return [];
    }
    const stock = await findStockBroll({
      moments: moments(transcript, duration, source.name),
      type: job.auto?.stockVideoType || "all",
      language: transcript?.language,
      matching: usesAI ? "ai" : "tags",
      targetAspect: dimensions.width / dimensions.height,
      workDir,
      signal,
      onPhase: (phase) => onPhase(phase, 62),
    });
    assets = stock.assets;
    stock.notes.forEach(addNote);
  }
  let aiMatches: AIMatch[] | undefined;
  if (usesAI) {
    aiMatches = [];
    if (transcript?.segments.length) {
        const ai = await matchBrollWithAI({
          assets,
          moments: moments(transcript, duration, source.name),
          workDir,
          signal,
          onPhase: (phase) => onPhase(phase, 64),
        });
        aiMatches = ai.matches;
        ai.notes.forEach(addNote);
    } else
      addNote(
        "AI B-roll matching needs a speech transcript. Original footage was kept.",
      );
  }
  const plans = planSupportingVisuals({
    transcript,
    duration,
    sourceName: source.name,
    assets,
    mode,
    aiMatches,
  });
  if (mode === "stock" || mode === "library" || mode === "both") job.brollCandidates = assets.slice(0, 20);
  const result: SupportingVisual[] = [];
  const details: NonNullable<RenderJob["supportingVisuals"]> = [];
  for (const [index, plan] of plans.entries()) {
    signal.throwIfAborted();
    if (plan.kind === "broll") {
      const asset = assets.find((item) => item.id === plan.assetId)!;
      if (asset.stock) {
        const checked = await inspectBrollWindows(asset, dimensions.width / dimensions.height, signal,
          { sourceStart: plan.sourceStart ?? 0, duration: plan.end - plan.start });
        if (!checked.length) {
          addNote("A stock shot was omitted because its final trimmed interval had insufficient visible motion.");
          continue;
        }
      }
      result.push({
        path: asset.filePath,
        start: plan.start,
        end: plan.end,
        sourceStart: plan.sourceStart ?? 0,
        label: asset.name,
        kind: "broll",
      });
      details.push({
        name: asset.name,
        kind: "broll",
        start: plan.start,
        end: plan.end,
        assetId: asset.id,
        ...(asset.attribution ? { attribution: asset.attribution } : {}),
        sourceStart: plan.sourceStart ?? 0,
        ...(plan.reason ? { reason: plan.reason } : {}),
        ...(asset.selection ? { selection: asset.selection } : {}),
        ...(asset.stock ? { stock: asset.stock } : {}),
      });
      if (plan.reason)
        addNote(
          `B-roll at ${plan.start.toFixed(1)}s: ${asset.name} — ${plan.reason}`,
        );
    } else {
      try {
        if (!(await graphicsAvailable()))
          throw new Error("Motion renderer unavailable");
        onPhase("Creating animated cards", 65);
        const output = path.join(workDir, `supporting-card-${index}.mp4`);
        await renderGraphic({
          text: plan.text,
          ...dimensions,
          duration: plan.end - plan.start,
          output,
          workDir,
          signal,
        });
        result.push({
          path: output,
          start: plan.start,
          end: plan.end,
          sourceStart: 0,
          label: plan.text,
          kind: "graphic",
        });
        details.push({
          name: plan.text,
          kind: "graphic",
          start: plan.start,
          end: plan.end,
        });
      } catch {
        signal.throwIfAborted();
        addNote(
          "An animated card could not be rendered. The original footage was kept for that moment.",
        );
      }
    }
  }
  removeGraphicCalloutOverlaps(job, result);
  const footageCount = details.filter((item) => item.kind === "broll").length;
  const cardCount = details.filter((item) => item.kind === "graphic").length;
  if (footageCount)
    job.summary!.changes.push(
      `${footageCount} B-roll cutaway${footageCount === 1 ? "" : "s"}`,
    );
  if (footageCount && usesAI) {
    job.summary!.changes.push("AI visual matching");
    job.summary!.usedAI = true;
  }
  if (cardCount)
    job.summary!.changes.push(
      `${cardCount} animated card${cardCount === 1 ? "" : "s"}`,
    );
  if (
    (mode === "stock" || mode === "library" || mode === "both") &&
    !footageCount
  )
    addNote(
      usesAI
        ? "No suitable AI B-roll match fit this edit. Original footage was kept."
        : mode === "stock"
          ? "No relevant stock B-roll fit this edit. Original footage was kept."
          : "No suitably timed B-roll match was found using the selected clip names and tags. Original footage was kept.",
    );
  if (
    (mode === "graphics" || mode === "both") &&
    !cardCount &&
    !plans.some((plan) => plan.kind === "graphic")
  )
    addNote(
      footageCount
        ? "No additional animated card fit within this edit’s timing and coverage limits."
        : "No suitable spoken phrase was available for an animated card. Original footage was kept.",
    );
  job.supportingVisuals = details;
  return result;
}
