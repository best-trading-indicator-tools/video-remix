import { formatSourceClock, MAX_SHORT_CUTS, parseSourceClock, type ShortCut } from "./shorts.js";
import type { Transcript } from "./types.js";

export type TranscriptEvent = { type: "progress"; message: string; progress: number }
  | { type: "result"; transcript: Transcript } | { type: "error"; message: string };
export interface TranscriptWordRef { index: number; segment: number; start: number; end: number; text: string; probability?: number }

/** Recognized word timings are approximate; keep a little air around a selection without reaching a neighboring word. */
const LEAD = 0.12, TAIL = 0.2, MIN_CUT = 0.05;

/** Usable words in source order. Indices are stable for one transcript. */
export function transcriptWords(transcript: Transcript): TranscriptWordRef[] {
  const words: Omit<TranscriptWordRef, "index">[] = [];
  transcript.segments.forEach((segment, index) => {
    for (const word of segment.words)
      if (Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start && word.word.trim())
        words.push({ segment: index, start: word.start, end: word.end, text: word.word, ...(word.probability !== undefined ? { probability: word.probability } : {}) });
  });
  return words.sort((a, b) => a.start - b.start || a.end - b.end).map((word, index) => ({ ...word, index }));
}

/** The source interval that plays the selected words, extended into the surrounding silence only. */
export function selectionInterval(words: TranscriptWordRef[], first: number, last: number, duration: number): { start: number; end: number } {
  const from = words[Math.min(first, last)]!, to = words[Math.max(first, last)]!;
  const before = words[from.index - 1], after = words[to.index + 1];
  const start = Math.min(from.start, Math.max(from.start - LEAD, before ? (before.end + from.start) / 2 : 0));
  const end = Math.max(to.end, Math.min(to.end + TAIL, after ? (to.end + after.start) / 2 : duration));
  return { start: Math.max(0, start), end: Math.min(duration, end) };
}

/** Which sequence plays each word (1-based, 0 when excluded), and the first word of every sequence. */
export function cutCoverage(words: TranscriptWordRef[], cuts: ShortCut[]): { sequence: number[]; starts: Map<number, number> } {
  const sequence = new Array<number>(words.length).fill(0);
  const starts = new Map<number, number>();
  cuts.forEach((cut, cutIndex) => {
    const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
    if (start === null || end === null || end <= start) return;
    let first: number | undefined;
    for (const word of words) {
      const middle = (word.start + word.end) / 2;
      if (middle < start || middle > end) continue;
      if (!sequence[word.index]) sequence[word.index] = cutIndex + 1;
      first ??= word.index;
    }
    if (first !== undefined && !starts.has(first)) starts.set(first, cutIndex + 1);
  });
  return { sequence, starts };
}

const plainCut = ({ id, start, end, focalPoint }: ShortCut): ShortCut => ({ id, start, end, ...(focalPoint ? { focalPoint } : {}) });

/** Append the selected speech as a new sequence. Face tracks are dropped because the sequence list changed. */
export function addTranscriptSelection(cuts: ShortCut[], interval: { start: number; end: number }, id: string): ShortCut[] | string {
  if (cuts.length >= MAX_SHORT_CUTS) return `A short can contain up to ${MAX_SHORT_CUTS} sequences.`;
  if (interval.end - interval.start < MIN_CUT) return "Select a little more speech to make a sequence.";
  return [...cuts.map(plainCut), { id, start: formatSourceClock(interval.start), end: formatSourceClock(interval.end) }];
}

/**
 * Remove the selected words from every sequence that plays them. Boundaries sit halfway into the
 * neighboring pauses, so the remaining words keep natural breathing room. A sequence that still has
 * speech on both sides is split in two; the first part keeps its ID.
 */
export function removeTranscriptSelection(cuts: ShortCut[], words: TranscriptWordRef[], first: number, last: number, newId: () => string): ShortCut[] | string {
  const from = words[Math.min(first, last)]!, to = words[Math.max(first, last)]!;
  const before = words[from.index - 1], after = words[to.index + 1];
  const removeStart = before ? Math.min(from.start, (before.end + from.start) / 2) : Math.max(0, from.start - LEAD);
  const removeEnd = after ? Math.max(to.end, (to.end + after.start) / 2) : to.end + TAIL;
  let changed = false;
  const next = cuts.flatMap(cut => {
    const start = parseSourceClock(cut.start), end = parseSourceClock(cut.end);
    if (start === null || end === null || end <= removeStart || start >= removeEnd) return [plainCut(cut)];
    changed = true;
    const parts = [[start, Math.min(end, removeStart)], [Math.max(start, removeEnd), end]].filter(([a, b]) => b! - a! >= MIN_CUT);
    return parts.map(([a, b], part) => ({ ...plainCut(cut), id: part === 0 ? cut.id : newId(), start: formatSourceClock(a!), end: formatSourceClock(b!) }));
  });
  if (!changed) return "The selected words are not in this short.";
  if (!next.length) return "A short needs at least one sequence. Add other words before removing these.";
  if (next.length > MAX_SHORT_CUTS) return `Removing these words would split the short into more than ${MAX_SHORT_CUTS} sequences.`;
  return next;
}

/** Lowercase letter and number runs without accents, for matching typed or quoted words. */
export const searchTokens = (text: string) => text.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) || [];
const normalized = searchTokens;

/** Next occurrence after a word index, wrapping to the start. The last typed word can be partial. */
export function findTranscriptWords(words: TranscriptWordRef[], query: string, after = -1): { first: number; last: number } | null {
  const tokens = normalized(query);
  if (!tokens.length || !words.length) return null;
  const text = words.map(word => normalized(word.text).join(""));
  const matchesAt = (index: number) => tokens.every((token, offset) => {
    const value = text[index + offset];
    return value !== undefined && (offset === tokens.length - 1 ? value.startsWith(token) : value === token);
  });
  for (let step = 1; step <= words.length; step++) {
    const index = (after + step + words.length) % words.length;
    if (index + tokens.length <= words.length && matchesAt(index)) return { first: index, last: index + tokens.length - 1 };
  }
  return null;
}

/** A readable short name from the first words of a selection. */
export function selectionTitle(words: TranscriptWordRef[], first: number, last: number): string {
  // Recognized words carry their own leading spaces, so languages written without spaces stay intact.
  const text = words.slice(Math.min(first, last), Math.max(first, last) + 1).map(word => word.text).join("").replace(/\s+/g, " ").trim();
  const title = text.split(" ").slice(0, 7).join(" ").replace(/[\s,;:.!?…-]+$/u, "");
  return (title.length > 90 ? `${title.slice(0, 89).trimEnd()}…` : title) || "Transcript short";
}
