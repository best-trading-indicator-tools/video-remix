import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transcript, TranscriptSegment } from "../shared/types.js";
import {
  buildCandidates,
  captionsSrt,
  cutsDuration,
  fallbackHook,
  retimeTranscript,
  sceneCuts,
  selectSpeechCuts,
} from "../server/auto-plan.js";

function speech(start: number, words: string[], step = 0.4): TranscriptSegment {
  return {
    start,
    end: start + words.length * step,
    text: words.join(" "),
    words: words.map((word, index) => ({
      start: start + index * step,
      end: start + (index + 1) * step - 0.05,
      word,
    })),
  };
}
const transcript = (
  segments: TranscriptSegment[],
  duration = Math.max(0, ...segments.map((segment) => segment.end)),
): Transcript => ({ language: "en", duration, segments });

test("candidate windows end at actual sentence boundaries, fit the target, and provide diverse alternatives", () => {
  const input = transcript(
    Array.from({ length: 20 }, (_, index) =>
      speech(index * 5 + 0.2, [
        `Idea${index}`,
        "is",
        "worth",
        "explaining",
        "clearly.",
      ]),
    ),
    100,
  );
  const candidates = buildCandidates(input, 100, 15, 0);
  assert.ok(candidates.length >= 3 && candidates.length <= 8);
  for (const candidate of candidates) {
    assert.ok(candidate.start >= 0 && candidate.end <= 100);
    assert.ok(candidate.end - candidate.start <= 15);
    assert.ok(candidate.text.endsWith("clearly."));
    for (const word of input.segments.flatMap((segment) => segment.words)) {
      assert.ok(
        !(word.start < candidate.start && word.end > candidate.start),
        "Start does not split a spoken word",
      );
      assert.ok(
        !(word.start < candidate.end && word.end > candidate.end),
        "End does not split a spoken word",
      );
    }
  }
  const otherVariant = buildCandidates(input, 100, 15, 1);
  assert.notDeepEqual(candidates[0], otherVariant[0]);
  assert.deepEqual(
    new Set(candidates.map((candidate) => candidate.start)),
    new Set(otherVariant.map((candidate) => candidate.start)),
  );
  assert.deepEqual(buildCandidates(transcript([]), 10, 5, 0), []);
  assert.deepEqual(
    buildCandidates(input, 100, 120, 0).map(({ start, end }) => ({
      start,
      end,
    })),
    [{ start: 0, end: 100 }],
  );
});

test("exceptionally long sentences are split only between real words and coarse timings stay intact", () => {
  const input = transcript(
    [
      speech(
        0.2,
        Array.from({ length: 50 }, (_, index) => `word${index}`),
        0.4,
      ),
    ],
    22,
  );
  const candidates = buildCandidates(input, 22, 5, 0);
  assert.ok(candidates.length >= 2);
  assert.ok(
    candidates.every((candidate) => candidate.end - candidate.start <= 5),
  );
  const coarse = transcript(
    [{ start: 1, end: 5, text: "An intact coarse sentence.", words: [] }],
    20,
  );
  const candidate = buildCandidates(coarse, 20, 6, 0)[0]!;
  assert.ok(candidate.start <= 1 && candidate.end >= 5);
  assert.deepEqual(selectSpeechCuts(coarse, candidate), [
    { start: candidate.start, end: candidate.end },
  ]);
});

test("speech cuts remove long pauses with padding while retaining brief pauses and every spoken word", () => {
  const input = transcript(
    [
      {
        start: 0.2,
        end: 6,
        text: "One two three four five.",
        words: [
          { word: "One", start: 0.2, end: 0.5 },
          { word: "two", start: 0.9, end: 1.2 },
          { word: "three", start: 2.5, end: 2.9 },
          { word: "four", start: 3.4, end: 3.8 },
          { word: "five.", start: 5.3, end: 5.8 },
        ],
      },
    ],
    6,
  );
  const cuts = selectSpeechCuts(input, {
    start: 0,
    end: 6,
    text: input.segments[0]!.text,
  });
  assert.equal(cuts.length, 3);
  assert.equal(cuts[0]!.start, 0);
  assert.ok(Math.abs(cuts[0]!.end - 1.35) < 1e-8);
  assert.ok(Math.abs(cuts[1]!.start - 2.35) < 1e-8);
  assert.ok(Math.abs(cuts[1]!.end - 3.95) < 1e-8);
  assert.ok(Math.abs(cuts[2]!.start - 5.15) < 1e-8);
  assert.equal(cuts[2]!.end, 6);
  assert.ok(cutsDuration(cuts) < 4);
  for (const word of input.segments[0]!.words)
    assert.ok(
      cuts.some((cut) => cut.start <= word.start && cut.end >= word.end),
    );
  const missing = structuredClone(input);
  missing.segments.push({
    start: 1.4,
    end: 2,
    text: "Unknown timing here.",
    words: [],
  });
  assert.deepEqual(selectSpeechCuts(missing, { start: 0, end: 6, text: "" }), [
    { start: 0, end: 6 },
  ]);
});

test("retiming follows reordered repeated cuts and excludes words clipped at edit boundaries", () => {
  const input = transcript(
    [
      speech(0, ["First", "complete", "sentence."]),
      speech(3, ["Second", "complete", "sentence."]),
    ],
    5,
  );
  const cuts = [
    { start: 3, end: 4.2 },
    { start: 0, end: 1.2 },
    { start: 3, end: 4.2 },
  ];
  const result = retimeTranscript(input, cuts);
  assert.ok(Math.abs(result.duration - 3.6) < 1e-8);
  assert.deepEqual(
    result.segments.map((segment) => segment.text),
    [
      "Second complete sentence.",
      "First complete sentence.",
      "Second complete sentence.",
    ],
  );
  assert.deepEqual(
    result.segments.map((segment) => Number(segment.start.toFixed(3))),
    [0, 1.2, 2.4],
  );
  for (const segment of result.segments)
    for (const word of segment.words)
      assert.ok(word.start >= 0 && word.end <= result.duration);
  const partial = retimeTranscript(input, [{ start: 0.2, end: 0.95 }]);
  assert.equal(partial.segments[0]!.text, "complete");
  const coarse = transcript(
    [
      {
        start: 0,
        end: 3,
        text: "Cannot infer missing word timings.",
        words: [],
      },
    ],
    3,
  );
  assert.equal(
    retimeTranscript(coarse, [{ start: 1, end: 2 }]).segments.length,
    0,
  );
});

test("captions keep actual words, bounded cue lengths, punctuation, and edited timestamps", () => {
  const input = transcript(
    [
      speech(
        0,
        [
          "This",
          "is",
          "a",
          "clear",
          "opening",
          "sentence.",
          "Then",
          "another",
          "idea",
          "follows.",
        ],
        0.45,
      ),
    ],
    5,
  );
  const edited = retimeTranscript(input, [
    { start: 2.7, end: 4.5 },
    { start: 0, end: 2.7 },
  ]);
  const srt = captionsSrt(edited);
  const blocks = srt.trim().split("\n\n");
  const getSeconds = (stamp: string) => {
    const [h, m, s, ms] = stamp.split(/[:,]/u).map(Number);
    return h! * 3600 + m! * 60 + s! + ms! / 1000;
  };
  const words: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const [start, end] = lines[1]!.split(" --> ").map(getSeconds);
    assert.ok(end! > start! && end! - start! <= 2.501);
    const chunk = lines.slice(2).join(" ").split(/\s+/u);
    assert.ok(chunk.length <= 6);
    words.push(...chunk);
  }
  assert.deepEqual(words, [
    "Then",
    "another",
    "idea",
    "follows.",
    "This",
    "is",
    "a",
    "clear",
    "opening",
    "sentence.",
  ]);
  assert.equal(captionsSrt(transcript([])), "");
});

test("fallback hooks extract supplied speech without invented copy", () => {
  const input = transcript([
    speech(0, [
      "A",
      "specific",
      "useful",
      "idea.",
      "More",
      "detail",
      "follows.",
    ]),
  ]);
  assert.equal(fallbackHook(input), "A specific useful idea.");
  const long = transcript([
    speech(
      0,
      Array.from({ length: 40 }, (_, index) => `Word${index}`),
    ),
  ]);
  assert.ok(fallbackHook(long).length <= 100);
  assert.ok(long.segments[0]!.text.startsWith(fallbackHook(long)));
  assert.equal(fallbackHook(transcript([])), "");
});

test("scene selection stays chronological and within source/target bounds across variants", () => {
  assert.deepEqual(sceneCuts([3, 6], 9, 15, 3), [{ start: 0, end: 9 }]);
  for (let variant = 0; variant < 6; variant++) {
    const cuts = sceneCuts(
      [30, 10, 20, 10, Number.NaN, -1, 90],
      50,
      17,
      variant,
    );
    assert.ok(cuts.length > 0 && cuts.length <= 60);
    assert.ok(cutsDuration(cuts) <= 17.00001);
    assert.ok(
      cuts.every(
        (cut, index) =>
          cut.start >= 0 &&
          cut.end <= 50 &&
          cut.end > cut.start &&
          (!index || cut.start >= cuts[index - 1]!.end),
      ),
    );
  }
  assert.notDeepEqual(sceneCuts([], 100, 15, 0), sceneCuts([], 100, 15, 1));
  assert.deepEqual(sceneCuts([], 0, 15, 0), []);
});
