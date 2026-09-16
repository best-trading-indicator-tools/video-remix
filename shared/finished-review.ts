import type { CaptionCue, RemixSettings, Transcript } from "./types.js";
import { captionsAfterInserts, footageTimeline } from "./own-footage.js";

export const FINISHED_REVIEW_VERSION = "finished-review-v1";
export const FINISHED_CHECK_NAMES = {
  "demonstration-hidden": "Demonstrations covered by another shot",
  "misleading-illustration": "Illustrative footage presented as evidence",
  "text-layout": "Cropped or conflicting visible text",
  "caption-speech": "Captions agree with rendered speech",
} as const;
export type FinishedCheckName = keyof typeof FINISHED_CHECK_NAMES;
export interface FinishedIssue {
  check: FinishedCheckName;
  start: number;
  end: number;
  message: string;
  evidence: string;
}
export interface FinishedReviewReport {
  version: typeof FINISHED_REVIEW_VERSION;
  checkedAt: string;
  status: "pass" | "review" | "partial" | "unavailable";
  checks: { name: FinishedCheckName; status: "pass" | "review" | "unavailable" | "not-applicable"; detail: string }[];
  issues: FinishedIssue[];
  picture: { frames: number; sourceFrames: number; totalVisualWindows: number; sampledVisualWindows: number; model?: string; reason?: string };
  audio: { windows: { start: number; end: number }[]; duration: number; captionWindowsCompared: number; reason?: string };
}
export interface FinishedSample {
  id: string;
  at: number;
  sourceAt?: number;
  /** Stable placement identity for sampled-coverage accounting. */
  visualId?: string;
  visualKind?: "broll" | "graphic" | "own-cover" | "own-insert";
  label?: string;
}

export function finishedTimeline(settings: RemixSettings, sourceDuration: number, sourceFps: number) {
  const unshiftedEnd = Math.min(settings.trimEnd ?? sourceDuration, sourceDuration);
  const length = unshiftedEnd - settings.trimStart;
  const start = Math.max(0, Math.min(settings.trimStart + settings.timeShift, sourceDuration - length));
  const cuts = settings.segments || [{ start, end: start + length }];
  const baseDuration = cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) / settings.speed;
  const fps = settings.fps === "source" ? sourceFps : Number(settings.fps);
  const timeline = footageTimeline(settings.ownFootage, baseDuration, fps);
  const toOutput = (at: number) => at + timeline.inserts.filter(item => item.at <= at).reduce((sum, item) => sum + item.length, 0);
  const sourceAt = (at: number): number | undefined => {
    let shift = 0;
    for (const insert of timeline.inserts) {
      if (at < insert.at + shift) break;
      if (at < insert.at + shift + insert.length) return undefined;
      shift += insert.length;
    }
    let remaining = Math.max(0, at - shift) * settings.speed;
    for (const cut of cuts) {
      if (remaining < cut.end - cut.start) return cut.start + remaining;
      remaining -= cut.end - cut.start;
    }
    return undefined;
  };
  const retime = <T extends { start: number; end: number }>(items: T[]): T[] => items.flatMap((item, i) =>
    captionsAfterInserts([{ id: String(i), start: item.start, end: item.end, text: "" }], settings.ownFootage || [], baseDuration, fps)
      .map(cue => ({ ...item, start: cue.start, end: cue.end })));
  return { ...timeline, baseDuration, fps, toOutput, sourceAt, retime };
}

/** Every timestamp refers to the final MP4, including added footage and playback speed. */
export function finishedSamples(settings: RemixSettings, sourceDuration: number, fps: number,
  visuals: { start: number; end: number; kind: "broll" | "graphic"; name?: string }[], maximum = 12) {
  const timeline = finishedTimeline(settings, sourceDuration, fps);
  const windows = timeline.retime(visuals.map((item, i) => ({ ...item, visualId: `visual-${i}`, label: item.name, visualKind: item.kind as FinishedSample["visualKind"] })))
    .map(item => ({ ...item, sourceComparison: true }));
  for (const cover of timeline.covers) windows.push(...timeline.retime([{ start: cover.at, end: cover.at + cover.length,
    kind: "broll" as const, name: "Your uploaded cover shot", visualId: cover.id, label: "Your uploaded cover shot", visualKind: "own-cover" as const, sourceComparison: true }]));
  let shift = 0;
  for (const insert of timeline.inserts) {
    windows.push({ start: insert.at + shift, end: insert.at + shift + insert.length, kind: "broll", name: "Your uploaded segment",
      visualId: insert.id, label: "Your uploaded segment", visualKind: "own-insert", sourceComparison: false });
    shift += insert.length;
  }
  const selected = windows.length <= maximum - 2 ? windows : Array.from({ length: maximum - 2 }, (_, index) => windows[Math.round(index * (windows.length - 1) / (maximum - 3))]!);
  const samples: FinishedSample[] = selected.map(item => {
    const at = (item.start + item.end) / 2;
    return { id: `sample-${item.visualId}-${at.toFixed(3)}`, at, sourceAt: item.sourceComparison ? timeline.sourceAt(at) : undefined,
      visualId: item.visualId, visualKind: item.visualKind, label: item.label };
  });
  for (const at of [Math.min(0.25, timeline.duration / 4), Math.max(0, timeline.duration - 0.25)]) {
    if (!samples.some(sample => Math.abs(sample.at - at) < 0.15)) samples.push({ id: `edge-${at.toFixed(3)}`, at, sourceAt: timeline.sourceAt(at) });
  }
  return { samples: samples.sort((a, b) => a.at - b.at), totalVisualWindows: new Set(windows.map(item => item.visualId)).size,
    captions: (cues: CaptionCue[]) => captionsAfterInserts(cues, settings.ownFootage || [], timeline.baseDuration, timeline.fps), timeline };
}

const words = (text: string) => text.toLocaleLowerCase().normalize("NFKC").replace(/[’']/gu, "").match(/[\p{L}\p{N}]+/gu) || [];
function agreement(a: string[], b: string[]): number {
  // Short caption windows keep this bounded; order matters, repeated words count once per occurrence.
  const row = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) { const previous = row[j]!; row[j] = word === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!); diagonal = previous; }
  }
  return a.length ? row[b.length]! / a.length : 0;
}

/** Compare groups of timed captions only where actual rendered speech was confidently recognized. */
export function compareRenderedCaptions(captions: CaptionCue[], transcript: Transcript, windows: { start: number; end: number }[]) {
  const issues: FinishedIssue[] = [];
  const groups: CaptionCue[] = [];
  for (const cue of [...captions].sort((a, b) => a.start - b.start)) {
    const previous = groups.at(-1);
    if (previous && cue.start - previous.end < 0.6 && cue.end - previous.start <= 8) {
      previous.end = Math.max(previous.end, cue.end); previous.text += ` ${cue.text}`;
    } else groups.push({ ...cue });
  }
  const recognized = transcript.segments.flatMap(segment => segment.words || []);
  let compared = 0;
  for (const cue of groups) {
    if (!windows.some(window => cue.start >= window.start && cue.end <= window.end)) continue;
    const expected = words(cue.text).slice(0, 80);
    const heard = recognized.filter(word => word.end > cue.start - 0.35 && word.start < cue.end + 0.35);
    const actual = words(heard.map(word => word.word).join(" ")).slice(0, 120);
    if (expected.length < 4 || actual.length < 4 || heard.filter(word => (word.probability ?? 0) >= 0.65).length / heard.length < 0.85) continue;
    compared++;
    const negations = new Set(["not", "never", "no", "cant", "cannot", "dont", "doesnt", "isnt", "wasnt", "wont", "shouldnt", "wouldnt", "couldnt"]);
    const inside = words(heard.filter(word => word.start >= cue.start && word.end <= cue.end && (word.probability ?? 0) >= 0.85).map(word => word.word).join(" "));
    const polarityChanged = agreement(expected.filter(word => !negations.has(word)), inside.filter(word => !negations.has(word))) >= 0.8 &&
      expected.some(word => negations.has(word)) !== inside.some(word => negations.has(word));
    if (agreement(expected, actual) < 0.4 || polarityChanged) issues.push({ check: "caption-speech", start: cue.start, end: cue.end,
      message: "The visible caption wording may disagree with the rendered speech. Listen to this interval.",
      evidence: `Caption: “${cue.text.slice(0, 240)}” · Recognized audio: “${heard.map(word => word.word).join(" ").slice(0, 240)}”` });
  }
  return { compared, issues: issues.slice(0, 20) };
}
