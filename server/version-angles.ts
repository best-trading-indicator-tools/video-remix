import type { EditSegment, RenderJob, Transcript } from "../shared/types.js";
import { ANGLE_NAMES, conclusionTeaser, type VersionAngle } from "../shared/version-angles.js";
import { cutsDuration, retimeTranscript } from "./auto-plan.js";
import { writeAnglePackaging } from "./intelligence.js";

/** Version 1 of the same video in this batch, once its moment has been chosen. */
export function angleLead(job: Pick<RenderJob, "id" | "batchId" | "sourceId">, previous: RenderJob[], reserved: RenderJob[]): RenderJob | undefined {
  const matches = (other: RenderJob) => other.id !== job.id && other.batchId === job.batchId && other.sourceId === job.sourceId &&
    other.variant === 1 && !!other.auto && !!other.settings.segments?.length;
  return reserved.find(other => matches(other) && other.status === "processing") ?? previous.find(other => matches(other) && other.status === "completed");
}

export interface AnglePlan { cuts: EditSegment[]; hook: string; callouts: string[]; usedAI: boolean; notes: string[]; changes: string[] }
const quoted = (text: string) => { const words = text.split(/\s+/u); return words.length > 12 ? `${words.slice(0, 12).join(" ")}…` : text; };

/**
 * Another angle on version 1's moment: the same footage with a different opening, structure and
 * on-screen text. When the angle cannot differ meaningfully, the reason lets the caller choose another
 * moment or explain why no duplicate was made.
 */
export async function planAngleVersion({ angle, lead, transcript, targetDuration, variant, signal }: {
  angle: Exclude<VersionAngle, "classic">; lead: RenderJob; transcript: Transcript; targetDuration: number; variant: number; signal: AbortSignal;
}): Promise<AnglePlan | { reason: string }> {
  const cuts = structuredClone(lead.settings.segments!);
  const text = retimeTranscript(transcript, cuts).segments.map(segment => segment.text).join(" ").replace(/\s+/gu, " ").trim();
  if (!text) return { reason: `${ANGLE_NAMES[angle]} needs recognized speech in version 1's moment.` };
  const packaging = await writeAnglePackaging({ angle, variant, language: transcript.language, signal,
    excerpt: { start: Math.min(...cuts.map(cut => cut.start)), end: Math.max(...cuts.map(cut => cut.end)), transcript: text } });
  signal.throwIfAborted();
  const changes = [`${ANGLE_NAMES[angle]} angle`];
  if (angle === "payoff") {
    const room = targetDuration - cutsDuration(cuts);
    const teaser = conclusionTeaser(transcript, cuts, packaging?.openingQuote, room);
    if (!teaser && !packaging) return { reason: room < 1
      ? `Replaying the conclusion would exceed the ${targetDuration}s limit, and DeepSeek was unavailable to write a new headline.`
      : "Version 1's moment has no separate concluding sentence to open with, and DeepSeek was unavailable to write a new headline." };
    if (teaser) changes.push("Conclusion-first opening");
    return {
      cuts: teaser ? [...teaser.cuts, ...cuts] : cuts,
      // Without AI, the opening words themselves become the spoken hook.
      hook: packaging?.hook ?? quoted(teaser!.text),
      callouts: packaging?.callouts ?? [], usedAI: !!packaging, changes,
      notes: [teaser
        ? `Angle: conclusion first. Opens with “${quoted(teaser.text)}” (${teaser.duration.toFixed(1)}s), then plays version 1's moment in full.`
        : room < 1
          ? `Angle: conclusion first. Replaying the conclusion would exceed the ${targetDuration}s limit, so only the headline leads with it.`
          : "Angle: conclusion first. No separate concluding sentence was found, so only the headline leads with it."],
    };
  }
  // Question and key-point angles differ through their written on-screen text.
  if (!packaging) return { reason: `${ANGLE_NAMES[angle]} needs DeepSeek to write its on-screen text, which was unavailable.` };
  return {
    cuts, hook: packaging.hook, callouts: packaging.callouts, usedAI: true, changes,
    notes: [angle === "question"
      ? `Angle: question first. Opens on “${packaging.hook}” over version 1's moment.`
      : packaging.callouts.length
        ? `Angle: key points. Numbers ${packaging.callouts.length} spoken point${packaging.callouts.length === 1 ? "" : "s"} on screen over version 1's moment.`
        : "Angle: key points. No separate points were found, so only the headline announces them."],
  };
}
