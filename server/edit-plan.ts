import { upscaleSchema } from "../shared/upscale.js";
import { z } from "zod";
import { ownFootageSchema } from "../shared/own-footage.js";
import type { CaptionCue, EditPlan, EditPlanChanges, EditSegment, Transcript } from "../shared/types.js";
import { MAX_BROLL_COUNT } from "../shared/types.js";
import { withTrackBounds } from "../shared/focus.js";
import { captionsSrt, cutsDuration, retimeTranscript } from "./auto-plan.js";
import { focalPointSchema, captionStyleSchema, focusTrackSchema, focusPointsWithinCut, focusPointsWithinBudget } from "./schema.js";
import { blackBandsSchema } from "../shared/black-bands.js";

const epsilon = 0.001;
const identity = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/u);
const time = z.number().finite().nonnegative();
const safeText = (maximum: number, empty = false) => z.string().max(maximum)
  .refine(text => empty || Boolean(text.trim()), "Caption text cannot be empty")
  .refine(text => !/[\u0000-\u0008\u000b-\u001f\u007f]|\n[ \t]*\n|\{\\|<[^>]*>|-->/u.test(text), "Use plain text without subtitle markup or control characters");
const cutSchema = z.object({ start: time, end: time, focalPoint: focalPointSchema.optional(), focusTrack: focusTrackSchema.optional() }).strict()
  .refine(focusPointsWithinCut, "Focus keyframes must stay within their source cut")
  .refine(cut => cut.end - cut.start >= 0.04 - 1e-9, "Each cut must contain at least 0.04 seconds");
const cutsSchema = z.array(cutSchema).min(1).max(60).refine(focusPointsWithinBudget, "Use at most 240 focus keyframes across all cuts");
const captionSchema = z.object({ id: identity, start: time, end: time, text: safeText(500) }).strict()
  .refine(cue => cue.end > cue.start && Math.round(cue.end * 1000) > Math.round(cue.start * 1000), "Each caption needs a positive duration at millisecond precision");
const visualSchema = z.object({
  id: identity,
  mediaId: identity,
  start: time,
  end: time,
  sourceStart: time,
  enabled: z.boolean(),
  locked: z.boolean(),
  reason: safeText(500).optional(),
  focalPoint: focalPointSchema.optional(),
}).strict().refine(visual => visual.end - visual.start >= 0.5 - 1e-9, "Each supporting shot must last at least 0.5 seconds");

export const editPlanChangesSchema = z.object({
  ownFootage: ownFootageSchema.optional(),
  revision: z.number().int().nonnegative(),
  refreshBroll: z.boolean().optional(),
  preserveBroll: z.boolean().optional(),
  brollCount: z.number().int().min(1).max(MAX_BROLL_COUNT).optional(),
  brollMaxCoverage: z.number().int().min(0).max(100).optional(),
  hookText: safeText(120, true).optional(),
  hookDuration: z.number().finite().min(0.5).max(15).optional(),
  captions: z.array(captionSchema).max(2000).optional(),
  cuts: cutsSchema.optional(),
  visuals: z.array(visualSchema).max(60).optional(),
  framing: z.object({ upscale: upscaleSchema.optional(), fit: z.enum(["crop", "contain", "blur"]).optional(), focalPoint: focalPointSchema.optional(), captionStyle: captionStyleSchema.optional(), blackBands: blackBandsSchema.optional() }).strict().optional(),
  correctionSeconds: z.number().finite().min(0).max(86400).optional(),
}).strict();

function uniqueIds(items: { id: string }[], name: string) {
  if (new Set(items.map(item => item.id)).size !== items.length)
    throw new Error(`${name} IDs must be unique`);
}
function noOverlap(items: { start: number; end: number }[], name: string) {
  const ordered = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  if (ordered.some((item, index) => index > 0 && item.start < ordered[index - 1]!.end - 1e-9))
    throw new Error(`${name} cannot overlap`);
}
function validateCaptions(cues: CaptionCue[], duration = Infinity): CaptionCue[] {
  const result = z.array(captionSchema).max(2000).parse(cues);
  uniqueIds(result, "Caption");
  noOverlap(result, "Captions");
  if (result.some(cue => cue.end > duration + epsilon))
    throw new Error("Caption timing must stay within the edited video");
  return result;
}
function stamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Canonical numeric cue headers keep caption content from becoming file syntax. */
export function captionCuesSrt(cues: CaptionCue[]): string {
  const ordered = validateCaptions(cues).sort((a, b) => a.start - b.start);
  return ordered.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.split("\n").map(line => line.trim()).join("\n")}`).join("\n\n") + (ordered.length ? "\n" : "");
}

export function parseCaptionCues(srt: string): CaptionCue[] {
  if (srt.length > 2 * 1024 * 1024) throw new Error("Caption file is too large");
  const text = srt.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (!text) return [];
  const timing = /^(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3})[ \t]*-->[ \t]*(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3})$/u;
  const cues = text.split(/\n[ \t]*\n+/u).map((block, index) => {
    const lines = block.split("\n");
    if (/^\d+$/u.test(lines[0]!.trim())) lines.shift();
    const matched = timing.exec((lines.shift() || "").trim());
    if (!matched || !lines.length) throw new Error("Each SRT caption needs a timestamp and plain text");
    const seconds = (offset: number) => Number(matched[offset]) * 3600 + Number(matched[offset + 1]) * 60 + Number(matched[offset + 2]) + Number(matched[offset + 3]) / 1000;
    return { id: `caption-${index + 1}`, start: seconds(1), end: seconds(5), text: lines.map(line => line.trim()).join("\n") };
  });
  // Speech recognizers can overlap adjacent word/segment edges by a few
  // milliseconds. Keep both phrases while removing that small timing overlap.
  // Submitted editor changes still use strict non-overlap validation.
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < cues.length; index++) {
    const cue = cues[index]!;
    const prior = cues[index - 1]!;
    if (cue.start < prior.end && prior.end - cue.start <= 0.1 + 1e-9 && prior.end < cue.end)
      cue.start = prior.end;
  }
  return validateCaptions(cues);
}

/** Source pieces covered by a complete output interval; neighboring cuts may join. */
function sourcePieces(interval: EditSegment, cuts: EditSegment[], speed: number): EditSegment[] {
  const pieces: EditSegment[] = [];
  let output = 0;
  for (const cut of cuts) {
    const end = output + (cut.end - cut.start) / speed;
    const left = Math.max(interval.start, output);
    const right = Math.min(interval.end, end);
    if (right > left + 1e-9) {
      const piece = { start: cut.start + (left - output) * speed, end: cut.start + (right - output) * speed };
      const previous = pieces.at(-1);
      if (previous && Math.abs(previous.end - piece.start) < 1e-7) previous.end = piece.end;
      else pieces.push(piece);
    }
    output = end;
  }
  return pieces;
}

/** No clipping: every source instant must survive in the same order. */
function mappedIntervals(interval: EditSegment, oldCuts: EditSegment[], newCuts: EditSegment[], speed: number): EditSegment[] {
  const pieces = sourcePieces(interval, oldCuts, speed);
  if (!pieces.length || Math.abs(cutsDuration(pieces) / speed - (interval.end - interval.start)) > epsilon) return [];
  const matches: EditSegment[] = [];
  const duration = cutsDuration(newCuts) / speed;
  let offset = 0;
  for (const cut of newCuts) {
    if (pieces[0]!.start >= cut.start - epsilon && pieces[0]!.start < cut.end - 1e-9) {
      const mappedStart = Math.max(0, offset + (pieces[0]!.start - cut.start) / speed);
      const start = Math.abs(mappedStart - interval.start) < 1e-9 ? interval.start : mappedStart;
      const proposed = { start, end: interval.end + (start - interval.start) };
      const proposedPieces = sourcePieces(proposed, newCuts, speed);
      if (proposed.end <= duration + epsilon && proposedPieces.length === pieces.length &&
        proposedPieces.every((piece, index) => Math.abs(piece.start - pieces[index]!.start) <= epsilon && Math.abs(piece.end - pieces[index]!.end) <= epsilon))
        matches.push(proposed);
    }
    offset += (cut.end - cut.start) / speed;
  }
  return matches;
}

function retimedCaptions(plan: EditPlan, cuts: EditSegment[], sourceTranscript?: Transcript): CaptionCue[] {
  const mapped = plan.captions.flatMap(cue => mappedIntervals(cue, plan.cuts, cuts, plan.settings.speed).map((timing, index) => ({
    ...cue, ...timing, id: index ? `${cue.id.slice(0, 100)}-repeat-${index}` : cue.id,
  })));
  // Existing repeated source passages can point to the same new occurrence.
  const distinct = mapped.filter((cue, index) => !mapped.slice(0, index).some(previous => Math.abs(previous.start - cue.start) < epsilon && Math.abs(previous.end - cue.end) < epsilon));
  if (!sourceTranscript || plan.captionMode === "off") return distinct.sort((a, b) => a.start - b.start);
  const transcript = retimeTranscript(sourceTranscript, cuts);
  const authoritative = distinct.sort((a, b) => a.start - b.start);
  const duration = transcript.duration / plan.settings.speed;
  let cursor = 0;
  const gaps: EditSegment[] = [];
  for (const cue of authoritative) {
    if (cue.start > cursor + epsilon) gaps.push({ start: cursor, end: cue.start });
    cursor = Math.max(cursor, cue.end);
  }
  if (duration > cursor + epsilon) gaps.push({ start: cursor, end: duration });
  const used = new Set(authoritative.map(cue => cue.id));
  let serial = 0;
  const generated = gaps.flatMap(gap => {
    // Existing complete cues are authoritative. Fill only uncovered speech,
    // using actual word boundaries so regrouping never overwrites a correction.
    const fill = retimeTranscript(transcript, [{ start: gap.start * plan.settings.speed, end: gap.end * plan.settings.speed }]);
    return parseCaptionCues(captionsSrt(fill)).map(cue => {
      let id: string;
      do { id = `caption-new-${plan.revision + 1}-${++serial}`; } while (used.has(id));
      used.add(id);
      return { ...cue, id, start: gap.start + cue.start / plan.settings.speed, end: gap.start + cue.end / plan.settings.speed };
    });
  });
  return [...authoritative, ...generated].sort((a, b) => a.start - b.start);
}

/** Apply one review revision without generating speech, choosing clips, or mutating the saved result. */
export function applyEditPlanChanges(plan: EditPlan, input: EditPlanChanges, sourceTranscript?: Transcript): EditPlan {
  // Boundary controls carry the saved trajectory unchanged. Clip only that
  // known track; newly supplied trajectories must already satisfy the schema.
  const boundedInput = input.cuts ? { ...input, cuts: input.cuts.map(cut => {
    const carried = cut.focusTrack && plan.cuts.some(previous => previous.focusTrack &&
      JSON.stringify(cut.focusTrack) === JSON.stringify(previous.focusTrack));
    return carried ? withTrackBounds(cut) : cut;
  }) } : input;
  const changes = editPlanChangesSchema.parse(boundedInput);
  if (changes.preserveBroll !== undefined && !changes.refreshBroll)
    throw new Error("Keeping existing shots requires a new stock search.");
  if (changes.brollCount !== undefined && !changes.refreshBroll)
    throw new Error("Choose a B-roll target when requesting a new stock search.");
  if (changes.brollMaxCoverage !== undefined && !changes.refreshBroll)
    throw new Error("Choose a coverage limit when requesting a new stock search.");
  if (changes.refreshBroll && changes.visuals !== undefined)
    throw new Error("Render your manual footage changes separately before searching for new B-roll.");
  if (changes.revision !== plan.revision) throw new Error("This edit changed since you opened it. Reload the latest revision before saving.");
  if (!Number.isFinite(plan.settings.speed) || plan.settings.speed <= 0) throw new Error("The saved edit has an invalid playback speed");
  const next = structuredClone(plan);
  if (changes.ownFootage) next.settings.ownFootage = structuredClone(changes.ownFootage);
  let cuts = changes.cuts ?? next.cuts;
  cuts = cuts.map((cut, index) => {
    const explicitPoint = changes.cuts?.[index]?.focalPoint;
    const carried = cut.focusTrack && plan.cuts.filter(previous => previous.focusTrack &&
      JSON.stringify(cut.focusTrack) === JSON.stringify(withTrackBounds({ ...previous, start: cut.start, end: cut.end }).focusTrack));
    // Cut indices change during reordering. A carried trajectory still belongs
    // to its original source cut, including when its new boundaries are tighter.
    const changedPoint = explicitPoint && carried?.length &&
      carried.every(previous => JSON.stringify(explicitPoint) !== JSON.stringify(previous.focalPoint));
    if (!changes.framing?.focalPoint && !changedPoint) return cut;
    const { focusTrack: _track, ...stationary } = cut;
    return changes.framing?.focalPoint && !changes.cuts && stationary.focalPoint
      ? { ...stationary, focalPoint: changes.framing.focalPoint } : stationary;
  });
  cutsSchema.parse(cuts);
  if (cuts.some(cut => cut.end > plan.sourceDuration + epsilon)) throw new Error("Cuts must stay within the original source video");
  const cutsChanged = JSON.stringify(cuts.map(({ start, end }) => ({ start, end }))) !== JSON.stringify(plan.cuts.map(({ start, end }) => ({ start, end })));
  const duration = cutsChanged ? cutsDuration(cuts) / plan.settings.speed : plan.outputDuration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("The edited video must have a positive duration");
  if (plan.narration && cutsChanged && Math.abs(duration - plan.outputDuration) > epsilon)
    throw new Error("Narration audio is locked. Keep the same total cut duration when changing narrated footage.");

  if (cutsChanged && !plan.narration) {
    next.captions = retimedCaptions(plan, cuts, sourceTranscript);
    next.captionWords = plan.captionWords?.flatMap(word => mappedIntervals(word, plan.cuts, cuts, plan.settings.speed).map(timing => ({ ...word, ...timing })));
    next.settings.callouts = next.settings.callouts?.flatMap(callout => {
      const timing = mappedIntervals(callout, plan.cuts, cuts, plan.settings.speed)[0];
      return timing ? [{ ...callout, ...timing }] : [];
    });
    next.visuals = next.visuals.flatMap(visual => {
      const timing = mappedIntervals(visual, plan.cuts, cuts, plan.settings.speed)[0];
      return timing ? [{ ...visual, ...timing }] : [];
    });
  }
  if (changes.hookDuration !== undefined) next.settings.hookDuration = changes.hookDuration;
  if (changes.hookText !== undefined) next.settings.hookText = changes.hookText;
  if (changes.framing) Object.assign(next.settings, structuredClone(changes.framing));
  if (changes.captions !== undefined) {
    next.captions = structuredClone(changes.captions);
    next.captionMode = changes.captions.length ? "generated" : "off";
  }
  if (changes.visuals !== undefined) {
    const original = new Map(plan.visuals.map(visual => [visual.id, visual]));
    const retimed = new Map(next.visuals.map(visual => [visual.id, visual]));
    for (const visual of changes.visuals) {
      const prior = original.get(visual.id);
      // New shots may use only media already retained by this edit (validated below).
      if (!prior) { if (visual.locked) throw new Error("New supporting shots must start unlocked"); continue; }
      const baseline = retimed.get(visual.id) ?? prior;
      if (prior.locked && visual.locked && (
        visual.mediaId !== baseline.mediaId || Math.abs(visual.start - baseline.start) > 1e-9 ||
        Math.abs(visual.end - baseline.end) > 1e-9 || Math.abs(visual.sourceStart - baseline.sourceStart) > 1e-9 ||
        JSON.stringify(visual.focalPoint) !== JSON.stringify(baseline.focalPoint)
      )) throw new Error("Unlock this supporting shot before changing its clip or timing");
    }
    next.visuals = structuredClone(changes.visuals);
  }
  uniqueIds(next.visuals, "Supporting shot");
  z.array(visualSchema).max(60).parse(next.visuals);
  const media = new Map(next.media.map(item => [item.id, item]));
  for (const visual of next.visuals) {
    const clip = media.get(visual.mediaId);
    if (!clip || clip.kind === "audio") throw new Error("Choose supporting footage already saved with this edit");
    if (visual.end > duration + epsilon) throw new Error("Supporting shot timing must stay within the edited video");
    if (visual.sourceStart + visual.end - visual.start > clip.duration + epsilon)
      throw new Error("Supporting shot timing exceeds the saved clip's duration");
  }
  const enabled = next.visuals.filter(visual => visual.enabled);
  if (enabled.length > MAX_BROLL_COUNT) throw new Error(`An edit can contain at most ${MAX_BROLL_COUNT} enabled supporting shots`);
  noOverlap(enabled, "Supporting shots");
  validateCaptions(next.captions, duration);
  next.cuts = structuredClone(cuts);
  next.settings.segments = structuredClone(cuts);
  next.outputDuration = duration;
  next.settings.trimStart = Math.min(...cuts.map(cut => cut.start));
  next.settings.trimEnd = Math.max(...cuts.map(cut => cut.end));
  if (cutsChanged) next.settings.hookDuration = Math.max(0.5, Math.min(next.settings.hookDuration, duration));
  next.revision = plan.revision + 1;
  return next;
}
