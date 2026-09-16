import { z } from "zod";
import type { EditSegment, Transcript } from "./types.js";
import { withTrackBounds } from "./focus.js";
export const pacingOptionsSchema = z
  .object({
    mode: z.enum(["off", "natural", "tight", "custom"]),
    minimumPause: z.number().min(0.4).max(5).default(0.9),
    keepPause: z.number().min(0.12).max(1).default(0.35),
    removeFillers: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => value.mode !== "custom" || value.keepPause < value.minimumPause,
    { message: "Retained pause must be shorter than the pause threshold." },
  );
export type PacingOptions = z.infer<typeof pacingOptionsSchema>;
export const NATURAL_PACING: PacingOptions = {
  mode: "natural",
  minimumPause: 0.9,
  keepPause: 0.35,
  removeFillers: false,
};
export const pacingRemovalSchema = z
  .object({
    id: z.string().max(120),
    cutIndex: z.number().int().min(0).max(59),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    kind: z.enum(["pause", "filler"]),
    label: z.string().max(160),
  })
  .strict()
  .refine((value) => value.end > value.start);
export type PacingRemoval = z.infer<typeof pacingRemovalSchema>;
export interface PacingSuggestion {
  removals: PacingRemoval[];
  notes: string[];
}
export function suggestPacing(
  transcript: Transcript,
  cuts: EditSegment[],
  input: PacingOptions,
): PacingSuggestion {
  const options = pacingOptionsSchema.parse(input);
  if (options.mode === "off") return { removals: [], notes: [] };
  const threshold =
    options.mode === "custom"
      ? options.minimumPause
      : options.mode === "tight"
        ? 0.6
        : 0.9;
  const keep =
    options.mode === "custom"
      ? options.keepPause
      : options.mode === "tight"
        ? 0.22
        : 0.35;
  const removals: PacingRemoval[] = [],
    notes: string[] = [];
  const fillers = transcript.language.startsWith("en")
    ? /^(um|uh|erm)$/i
    : transcript.language.startsWith("fr")
      ? /^(euh)$/i
      : transcript.language.startsWith("de")
        ? /^(äh|ähm)$/i
        : /$a/;
  for (const [cutIndex, cut] of cuts.entries()) {
    const segments = transcript.segments.filter(
      (segment) => segment.start < cut.end && segment.end > cut.start,
    );
    const reliable =
      segments.length &&
      segments.every(
        (segment) =>
          segment.words.length >=
            Math.ceil(segment.text.trim().split(/\s+/u).length / 2) &&
          segment.words.length > 0 &&
          segment.words.every(
            (word, i) =>
              Number.isFinite(word.start) &&
              Number.isFinite(word.end) &&
              word.end > word.start &&
              word.start >= segment.start - 0.2 &&
              word.end <= segment.end + 0.2 &&
              (!i || word.start >= segment.words[i - 1].end - 0.06),
          ),
      );
    if (!reliable) {
      notes.push(
        `Sequence ${cutIndex + 1} has no reliable word timing; its pacing was preserved.`,
      );
      continue;
    }
    const words = segments
      .flatMap((segment) => segment.words)
      .filter((word) => word.start >= cut.start && word.end <= cut.end)
      .sort((a, b) => a.start - b.start);
    let occupiedEnd = words[0]?.end ?? cut.start;
    for (let index = 1; index < words.length; index++) {
      const word = words[index];
      if (word.start - occupiedEnd > threshold) {
        const start = occupiedEnd + keep / 2,
          end = word.start - keep / 2;
        removals.push({
          id: `${cutIndex}:pause:${start.toFixed(4)}:${end.toFixed(4)}`,
          cutIndex,
          start,
          end,
          kind: "pause",
          label: `Pause between “${words[index - 1].word.trim().slice(0, 40)}” and “${word.word.trim().slice(0, 40)}”`,
        });
      }
      occupiedEnd = Math.max(occupiedEnd, word.end);
    }
    if (options.removeFillers)
      for (let index = 1; index < words.length - 1; index++) {
        const word = words[index],
          token = word.word.replace(/[^\p{L}]/gu, "");
        if (
          !fillers.test(token) ||
          (word.probability ?? 0) < 0.9 ||
          word.end - word.start > 1.2 ||
          word.start - words[index - 1].end < 0.08 ||
          words[index + 1].start - word.end < 0.08
        )
          continue;
        removals.push({
          id: `${cutIndex}:filler:${word.start.toFixed(4)}:${word.end.toFixed(4)}`,
          cutIndex,
          start: word.start,
          end: word.end,
          kind: "filler",
          label: `Isolated “${token}”`,
        });
      }
  }
  removals.sort((a, b) => a.cutIndex - b.cutIndex || a.start - b.start);
  const limit = Math.max(0, 60 - cuts.length);
  if (removals.length > limit)
    notes.push(
      "Some trims were left out to keep this edit within 60 sequences.",
    );
  return { removals: removals.slice(0, limit), notes };
}

/** Subtract only approved intervals from their specific occurrence in the source sequence. */
export function applyPacing(
  cuts: EditSegment[],
  removals: PacingRemoval[],
  skippedIds: string[] = [],
): EditSegment[] {
  const ignored = new Set(skippedIds);
  return cuts.flatMap((cut, cutIndex) => {
    const intervals = removals
      .filter(
        (removal) =>
          removal.cutIndex === cutIndex &&
          !ignored.has(removal.id) &&
          removal.start >= cut.start &&
          removal.end <= cut.end &&
          removal.end > removal.start,
      )
      .sort((a, b) => a.start - b.start);
    const result: EditSegment[] = [];
    let cursor = cut.start;
    for (const interval of intervals) {
      if (
        interval.start < cursor ||
        interval.start - cursor < 0.05 ||
        cut.end - interval.end < 0.05
      )
        continue;
      result.push(
        withTrackBounds({ ...cut, start: cursor, end: interval.start }),
      );
      cursor = interval.end;
    }
    result.push(withTrackBounds({ ...cut, start: cursor }));
    return result;
  });
}

export const pacingReviewSchema = z
  .object({
    baseCuts: z
      .array(
        z.object({
          id: z.string().max(200),
          start: z.string().max(32),
          end: z.string().max(32),
          focalPoint: z
            .object({
              x: z.number().min(0).max(1),
              y: z.number().min(0).max(1),
            })
            .optional(),
        }),
      )
      .min(1)
      .max(60),
    options: pacingOptionsSchema,
    removals: z.array(pacingRemovalSchema).max(59),
    skippedIds: z.array(z.string().max(120)).max(59),
    appliedSignature: z.string().max(20000).optional(),
    notes: z.array(z.string().max(500)).max(61),
  })
  .refine(
    (review) =>
      review.removals.length + review.baseCuts.length <= 60 &&
      new Set(review.baseCuts.map((cut) => cut.id)).size ===
        review.baseCuts.length &&
      review.removals.every((item) => item.cutIndex < review.baseCuts.length) &&
      new Set(review.removals.map((item) => item.id)).size ===
        review.removals.length,
  );
export type PacingReview = z.infer<typeof pacingReviewSchema>;
export const pacingCutSignature = (
  cuts: { id: string; start: string; end: string }[],
) => JSON.stringify(cuts.map(({ id, start, end }) => ({ id, start, end })));
