import type {
  EditSegment,
  Transcript,
  TranscriptSegment,
  TranscriptWord,
} from "../shared/types.js";
import type { Candidate } from "./intelligence.js";

const clean = (text: string) => text.replace(/\s+/gu, " ").trim();
const annotation = (text: string) =>
  /^(?:\[|\()(?:music|applause|silence|laughter|noise|inaudible|unintelligible)(?:\]|\))$/iu.test(
    clean(text),
  );
const terminal = (text: string) => /[.!?。！？]["'”’)]*$/u.test(text.trim());
const joinWords = (words: TranscriptWord[]) =>
  clean(words.map((word) => word.word).join(" ")).replace(
    /\s+([,.;:!?。！？])/gu,
    "$1",
  );
const validTime = (start: number, end: number) =>
  Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
export const cutsDuration = (cuts: EditSegment[]): number =>
  cuts.reduce((sum, cut) => sum + Math.max(0, cut.end - cut.start), 0);

function reliable(segment: TranscriptSegment): boolean {
  const words = segment.words;
  return (
    words.length > 0 &&
    words.length >= Math.ceil(clean(segment.text).split(/\s+/u).length / 2) &&
    words.every(
      (word, index) =>
        clean(word.word) &&
        validTime(word.start, word.end) &&
        word.start >= segment.start - 0.2 &&
        word.end <= segment.end + 0.2 &&
        (!index || word.start >= words[index - 1]!.end - 0.06),
    )
  );
}

function spokenUnits(transcript: Transcript, target: number): Candidate[] {
  const units: Candidate[] = [];
  let pending: TranscriptWord[] = [];
  const flush = () => {
    if (pending.length)
      units.push({
        start: pending[0]!.start,
        end: pending.at(-1)!.end,
        text: joinWords(pending),
      });
    pending = [];
  };
  for (const segment of [...transcript.segments].sort(
    (a, b) => a.start - b.start,
  )) {
    if (
      !clean(segment.text) ||
      annotation(segment.text) ||
      !validTime(segment.start, segment.end)
    )
      continue;
    if (!reliable(segment)) {
      flush();
      units.push({
        start: segment.start,
        end: segment.end,
        text: clean(segment.text),
      });
      continue;
    }
    for (const word of segment.words) {
      // Complete sentences are preferred; exceptionally long sentences can
      // only fit the requested cap by ending at an actual word boundary.
      if (
        pending.length &&
        (word.end - pending[0]!.start > Math.max(0.1, target - 0.3) ||
          word.start - pending.at(-1)!.end > 0.9)
      )
        flush();
      pending.push(word);
      if (terminal(word.word)) flush();
    }
  }
  flush();
  return units;
}

export function buildCandidates(
  transcript: Transcript,
  sourceDuration: number,
  targetDuration: number,
  variant: number,
): Candidate[] {
  if (
    !Number.isFinite(sourceDuration) ||
    sourceDuration <= 0 ||
    !Number.isFinite(targetDuration) ||
    targetDuration <= 0
  )
    return [];
  const units = spokenUnits(transcript, targetDuration).filter(
    (unit) => unit.start < sourceDuration && unit.end > 0,
  );
  if (!units.length) return [];
  if (sourceDuration <= targetDuration)
    return [
      {
        start: 0,
        end: sourceDuration,
        text: clean(units.map((unit) => unit.text).join(" ")),
      },
    ];
  const pool: { candidate: Candidate; score: number }[] = [];
  for (let index = 0; index < units.length; index++) {
    const first = units[index]!;
    const start = Math.max(0, first.start - 0.12);
    let last = index;
    while (
      last + 1 < units.length &&
      units[last + 1]!.end + 0.18 - start <= targetDuration
    )
      last++;
    const end = Math.min(sourceDuration, units[last]!.end + 0.18);
    if (end - start > targetDuration || end <= start) continue;
    const selected = units.slice(index, last + 1);
    const speech = selected.reduce(
      (sum, item) => sum + item.end - item.start,
      0,
    );
    const candidate = {
      start,
      end,
      text: clean(selected.map((item) => item.text).join(" ")),
    };
    const score =
      Math.min(1, (end - start) / targetDuration) * 0.5 +
      Math.min(1, speech / (end - start)) * 0.3 +
      (terminal(selected.at(-1)!.text) ? 0.2 : 0);
    pool.push({ candidate, score });
  }
  pool.sort(
    (a, b) => b.score - a.score || a.candidate.start - b.candidate.start,
  );
  const chosen: Candidate[] = [];
  for (const { candidate } of pool) {
    const redundant = chosen.some((previous) => {
      const overlap = Math.max(
        0,
        Math.min(previous.end, candidate.end) -
          Math.max(previous.start, candidate.start),
      );
      const union =
        Math.max(previous.end, candidate.end) -
        Math.min(previous.start, candidate.start);
      return overlap / union > 0.6;
    });
    if (!redundant) chosen.push(candidate);
    if (chosen.length === 8) break;
  }
  if (!chosen.length) return [];
  const offset =
    ((Math.floor(variant) % chosen.length) + chosen.length) % chosen.length;
  return [...chosen.slice(offset), ...chosen.slice(0, offset)];
}

export function selectSpeechCuts(
  transcript: Transcript,
  candidate: Candidate,
): EditSegment[] {
  if (!validTime(candidate.start, candidate.end)) return [];
  const fallback = [{ start: candidate.start, end: candidate.end }];
  const relevant = transcript.segments.filter(
    (segment) =>
      segment.end > candidate.start &&
      segment.start < candidate.end &&
      clean(segment.text),
  );
  if (!relevant.length || relevant.some((segment) => !reliable(segment)))
    return fallback;
  const words = relevant
    .flatMap((segment) => segment.words)
    .filter(
      (word) =>
        word.start >= candidate.start - 0.001 &&
        word.end <= candidate.end + 0.001,
    )
    .sort((a, b) => a.start - b.start);
  if (!words.length) return fallback;
  const cuts: EditSegment[] = [];
  let start =
    words[0]!.start - candidate.start > 0.65
      ? Math.max(candidate.start, words[0]!.start - 0.15)
      : candidate.start;
  let lastEnd = words[0]!.end;
  for (const word of words.slice(1)) {
    if (word.start - lastEnd > 0.65 && cuts.length < 59) {
      cuts.push({ start, end: Math.min(candidate.end, lastEnd + 0.15) });
      start = Math.max(candidate.start, word.start - 0.15);
    }
    lastEnd = Math.max(lastEnd, word.end);
  }
  cuts.push({
    start,
    end:
      candidate.end - lastEnd > 0.65
        ? Math.min(candidate.end, lastEnd + 0.15)
        : candidate.end,
  });
  return cuts;
}

export function retimeTranscript(
  transcript: Transcript,
  cuts: EditSegment[],
): Transcript {
  const segments: TranscriptSegment[] = [];
  let offset = 0;
  for (const cut of cuts) {
    if (!validTime(cut.start, cut.end)) continue;
    for (const segment of transcript.segments) {
      if (segment.end <= cut.start || segment.start >= cut.end) continue;
      if (reliable(segment)) {
        const words = segment.words
          .filter(
            (word) =>
              word.start >= cut.start - 0.001 && word.end <= cut.end + 0.001,
          )
          .map((word) => ({
            ...word,
            start: Math.max(offset, offset + word.start - cut.start),
            end: Math.min(
              offset + cut.end - cut.start,
              offset + word.end - cut.start,
            ),
          }));
        if (words.length)
          segments.push({
            start: words[0]!.start,
            end: words.at(-1)!.end,
            text: joinWords(words),
            words,
          });
      } else if (
        segment.start >= cut.start - 0.001 &&
        segment.end <= cut.end + 0.001
      ) {
        // Without word timings, partial segments cannot be safely captioned:
        // including the entire text would attribute words to missing footage.
        segments.push({
          start: offset + segment.start - cut.start,
          end: offset + segment.end - cut.start,
          text: clean(segment.text),
          words: [],
        });
      }
    }
    offset += cut.end - cut.start;
  }
  segments.sort((a, b) => a.start - b.start || a.end - b.end);
  return { language: transcript.language, duration: offset, segments };
}

function stamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function captionsSrt(transcript: Transcript): string {
  const cues: { start: number; end: number; text: string }[] = [];
  for (const segment of transcript.segments) {
    if (!clean(segment.text)) continue;
    if (!reliable(segment)) {
      // Coarse transcript segments have no real word timing. Divide their
      // existing words evenly over the known cue, without inventing content.
      const tokens = clean(segment.text).split(/\s+/u);
      const span = segment.end - segment.start;
      if (span <= 0) continue;
      const groupSize = Math.max(
        1,
        Math.min(6, Math.floor((tokens.length * 2.5) / span)),
      );
      for (let index = 0; index < tokens.length; index += groupSize) {
        const endIndex = Math.min(tokens.length, index + groupSize);
        cues.push({
          start: segment.start + (span * index) / tokens.length,
          end: Math.min(
            segment.start + (span * endIndex) / tokens.length,
            segment.start + (span * index) / tokens.length + 2.5,
          ),
          text: tokens.slice(index, endIndex).join(" "),
        });
      }
      continue;
    }
    let pending: TranscriptWord[] = [];
    const flush = () => {
      if (pending.length)
        cues.push({
          start: pending[0]!.start,
          end: Math.min(pending.at(-1)!.end, pending[0]!.start + 2.5),
          text: joinWords(pending),
        });
      pending = [];
    };
    for (const word of segment.words) {
      if (
        pending.length &&
        (pending.length === 6 ||
          word.end - pending[0]!.start > 2.5 ||
          word.start - pending.at(-1)!.end > 0.65)
      )
        flush();
      pending.push(word);
      if (pending.length >= 3 && terminal(word.word)) flush();
    }
    flush();
  }
  return (
    cues
      .filter((cue) => cue.end > cue.start && cue.text)
      .map(
        (cue, index) =>
          `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}`,
      )
      .join("\n\n") + (cues.length ? "\n" : "")
  );
}

export function fallbackHook(transcript: Transcript): string {
  for (const segment of transcript.segments) {
    const text = clean(segment.text);
    if (!text || annotation(text)) continue;
    const phrase = text.split(/(?<=[.!?。！？])\s+/u)[0]!;
    if (phrase.length <= 100) return phrase;
    const words = phrase.split(/\s+/u);
    let hook = "";
    for (const word of words) {
      if (`${hook}${hook ? " " : ""}${word}`.length > 100) break;
      hook += `${hook ? " " : ""}${word}`;
    }
    if (hook) return hook;
    return Array.from(phrase).slice(0, 100).join("");
  }
  return "";
}

export function sceneCuts(
  sceneTimes: number[],
  duration: number,
  targetDuration: number,
  variant: number,
): EditSegment[] {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(targetDuration) ||
    targetDuration <= 0
  )
    return [];
  if (duration <= targetDuration) return [{ start: 0, end: duration }];
  const boundaries = [
    ...new Set([
      0,
      ...sceneTimes.filter(
        (time) => Number.isFinite(time) && time > 0 && time < duration,
      ),
      duration,
    ]),
  ].sort((a, b) => a - b);
  const scenes = boundaries
    .slice(0, -1)
    .map((start, index) => ({ start, end: boundaries[index + 1]! }))
    .filter((cut) => cut.end - cut.start >= 0.04);
  if (!scenes.length) return [];
  const startIndex =
    ((Math.floor(variant) % scenes.length) + scenes.length) % scenes.length;
  const chosen: EditSegment[] = [];
  let remaining = targetDuration;
  // Pick whole scenes where possible, then use a bounded part of a long one.
  for (const scene of [
    ...scenes.slice(startIndex),
    ...scenes.slice(0, startIndex),
  ]) {
    if (remaining < 0.04 || chosen.length === 60) break;
    const length = Math.min(scene.end - scene.start, remaining);
    const room = scene.end - scene.start - length;
    const start =
      scene.start +
      (room > 0 && scenes.length === 1
        ? (room * (((Math.floor(variant) % 5) + 5) % 5)) / 4
        : 0);
    chosen.push({ start, end: start + length });
    remaining -= length;
  }
  return chosen.sort((a, b) => a.start - b.start);
}
