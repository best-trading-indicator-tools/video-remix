import { findTranscriptWords, searchTokens, selectionInterval, transcriptWords } from "./transcript-edit.js";
import type { AutoOptions, EditSegment, TimedCallout, Transcript } from "./types.js";

/**
 * Versions of one moment that are built differently: another opening, structure and on-screen text,
 * rather than the same edit with small speed or color changes.
 */
export const VERSION_ANGLES = ["classic", "payoff", "question", "points"] as const;
export type VersionAngle = (typeof VERSION_ANGLES)[number];
export const MAX_ANGLE_VERSIONS = VERSION_ANGLES.length;
export const ANGLE_NAMES: Record<VersionAngle, string> = {
  classic: "Classic", payoff: "Conclusion first", question: "Question first", points: "Key points",
};
export const ANGLE_DESCRIPTIONS: Record<VersionAngle, string> = {
  classic: "The selected moment as Auto normally edits it.",
  payoff: "Opens with the moment's conclusion, then plays it in full.",
  question: "Opens on the question the moment answers.",
  points: "Numbers the points the speaker makes on screen.",
};
/** A different caption look per angle, used only when no caption style was chosen. */
export const ANGLE_CAPTION_PRESET: Partial<Record<VersionAngle, string>> = { payoff: "punch", question: "editorial", points: "box" };

export function versionAngle(options: Pick<AutoOptions, "versionMode">, variant: number): VersionAngle | undefined {
  return options.versionMode === "angles" && Number.isInteger(variant) && variant >= 1 && variant <= MAX_ANGLE_VERSIONS
    ? VERSION_ANGLES[variant - 1] : undefined;
}

const MAX_TEASER = 7, MIN_TEASER = 1;
const sentenceEnd = /[.!?…。！？]["'”’)\]]*$/u;
const length = (cuts: EditSegment[]) => cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);

export interface Teaser { cuts: EditSegment[]; text: string; duration: number }

/**
 * The conclusion to play once more as a cold open: the verbatim quote when it is found inside the
 * excerpt (and is not its opening), otherwise the final sentence. The teaser keeps the excerpt's own
 * cuts, so removed pauses stay removed. Null when there is no separate conclusion or it does not fit.
 */
export function conclusionTeaser(transcript: Transcript, cuts: EditSegment[], quote: string | undefined, room: number): Teaser | null {
  const inside = (time: number) => cuts.some(cut => time >= cut.start - 0.001 && time <= cut.end + 0.001);
  const ranges: { start: number; end: number; text: string }[] = [];
  const words = transcriptWords(transcript);
  const spoken = words.filter(word => inside((word.start + word.end) / 2));
  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  if (spoken.length) {
    const range = (first: number, last: number) => ({ ...selectionInterval(words, spoken[first]!.index, spoken[last]!.index, transcript.duration),
      text: clean(spoken.slice(first, last + 1).map(word => word.text).join("")) });
    const found = quote ? findTranscriptWords(spoken, quote) : null;
    if (found && found.first > 0 && found.last - found.first >= 2) ranges.push(range(found.first, found.last));
    let first = spoken.length - 1;
    while (first > 0 && !sentenceEnd.test(spoken[first - 1]!.text.trim())) first--;
    if (first > 0) ranges.push(range(first, spoken.length - 1));
  } else {
    // Without word timings only complete recognized segments can be placed safely.
    const segments = transcript.segments.filter(segment => segment.end > segment.start && segment.text.trim() &&
      cuts.some(cut => segment.start >= cut.start - 0.001 && segment.end <= cut.end + 0.001));
    const wanted = quote ? searchTokens(quote).join(" ") : "";
    const quoted = wanted ? segments.find(segment => searchTokens(segment.text).join(" ").includes(wanted)) : undefined;
    for (const chosen of [quoted && quoted !== segments[0] ? quoted : undefined, segments.length > 1 ? segments.at(-1) : undefined])
      if (chosen) ranges.push({ start: chosen.start, end: chosen.end, text: clean(chosen.text) });
  }
  // The quoted conclusion wins when it fits; otherwise the final sentence is tried.
  for (const range of ranges) {
    const teaser = cuts.flatMap(cut => {
      const start = Math.max(cut.start, range.start), end = Math.min(cut.end, range.end);
      return end - start >= 0.05 ? [{ ...cut, start, end }] : [];
    });
    const duration = length(teaser);
    if (duration >= MIN_TEASER && duration <= Math.min(MAX_TEASER, length(cuts) * 0.6) && duration <= room + 0.001)
      return { cuts: teaser, text: range.text, duration };
  }
  return null;
}

/** Key points in the order they are spoken, numbered on screen. */
export const numberedCallouts = (callouts: TimedCallout[]): TimedCallout[] =>
  [...callouts].sort((a, b) => a.start - b.start).map((callout, index) => ({ ...callout, text: `${index + 1}. ${callout.text}` }));
