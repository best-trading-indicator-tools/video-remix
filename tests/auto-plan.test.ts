import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AUTO_OPTIONS,
  DEFAULT_SETTINGS,
  MAX_AUTO_VERSIONS,
  type RenderJob,
  type Transcript,
  type TranscriptSegment,
} from "../shared/types.js";
import {
  buildCandidates,
  captionsSrt,
  cutsDuration,
  fallbackHook,
  retimeTranscript,
  sceneCuts,
  selectSpeechCuts,
  alignCallouts,
  createSpeechCutSelector,
} from "../server/auto-plan.js";
import {
  completedAutoSiblings,
  footageOverlap,
  isRepeatedPlan,
  type EditorialPlan,
} from "../server/diversity.js";
import { AutoSkipError, prepareAutoRemix } from "../server/auto.js";
import { autoSourceBusy } from "../server/queue.js";

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
  const shortSource = buildCandidates(input, 100, 120, 0);
  assert.ok(shortSource.length > 1, "A source below the duration cap can still contain several focused ideas");
  assert.ok(shortSource.every(candidate => candidate.start >= 0 && candidate.end <= 100));
  assert.ok(shortSource[0]!.end - shortSource[0]!.start < 100, "Do not fill the cap with unrelated sentences");
});

test("a complete question and answer outrank the answer alone or an unanswered opening", () => {
  const input = transcript([
    { start: 0, end: 2, text: "How do you prevent blurry photographs?", words: [] },
    { start: 2.5, end: 6, text: "Use a faster shutter speed to freeze the moving subject.", words: [] },
    { start: 8, end: 10, text: "That is why it works.", words: [] },
    { start: 15, end: 17, text: "Thank you for watching.", words: [] },
  ], 22);
  const candidates = buildCandidates(input, 22, 12, 0);
  assert.match(candidates[0]!.text, /^How do you prevent.*Use a faster shutter/su);
  assert.ok(!candidates[0]!.text.endsWith("?"));
  assert.ok(candidates[0]!.end < 12, "A complete answer does not need to fill the duration");
});

test("nearby qualifications stay with the claim and context identifies excluded neighboring speech", () => {
  const input = transcript([
    { start: 0, end: 4, text: "The treatment improved symptoms in our small trial.", words: [] },
    { start: 4.5, end: 8, text: "However, the result has not been tested in children.", words: [] },
    { start: 15, end: 20, text: "Moving on to a different subject.", words: [] },
  ], 30);
  const candidate = buildCandidates(input, 30, 12, 0)[0]!;
  assert.match(candidate.text, /^The treatment.*However/su);
  assert.ok(candidate.end < 12);
  assert.match(candidate.context!.after, /different subject/u);
  assert.ok(!candidate.text.includes("different subject"));
});

test("padding never splits adjacent words and unknown-language or unpunctuated speech retains a fallback", () => {
  const input = transcript([speech(0, ["First", "sentence.", "Second", "sentence.", "Third", "sentence."])], 8);
  for (const candidate of buildCandidates(input, 8, 2, 0))
    for (const word of input.segments[0]!.words) {
      assert.ok(!(word.start < candidate.start && candidate.start < word.end));
      assert.ok(!(word.start < candidate.end && candidate.end < word.end));
    }
  const french = transcript([{ start: 1, end: 5, text: "Cette méthode fonctionne dans certains cas", words: [] }], 10);
  french.language = "fr";
  assert.ok(buildCandidates(french, 10, 8, 0).length, "English discourse hints cannot block other languages");
});

test("long-source candidate discovery reads transcript bounds linearly with and without history", () => {
  const count = 5000;
  let timestampReads = 0;
  const segments = Array.from({ length: count }, (_, index): TranscriptSegment => ({
    get start() { timestampReads++; return index * 3; },
    get end() { timestampReads++; return index * 3 + 2; },
    text: `Topic${index} explains a specific practical lesson.`, words: [],
  }));
  const source: Transcript = { language: "en", duration: count * 3, segments };
  const earlier: EditorialPlan[] = [{ cuts: [{ start: 0, end: 8.18 }],
    text: segments.slice(0, 3).map(segment => segment.text).join(" ") }];
  for (const history of [[], earlier]) {
    timestampReads = 0;
    const candidates = buildCandidates(source, source.duration, 15, 0, history);
    assert.ok(candidates.length > 0);
    assert.ok(timestampReads < count * 40,
      `Expected bounded source indexing, saw ${timestampReads} timestamp reads for ${count} segments`);
    for (const candidate of candidates)
      assert.equal(isRepeatedPlan({ cuts: selectSpeechCuts(source, candidate), text: candidate.text }, history), false);
  }
});

test("indexed speech lookup preserves overlapping coarse segments and exactly matches direct cuts", () => {
  const source = transcript([
    { start: 0, end: 20, text: "A coarse overlapping transcript interval.", words: [] },
    speech(2, ["First", "specific", "idea."]),
    speech(8, ["Second", "specific", "idea."]),
    speech(23, ["A", "later", "idea."]),
  ], 30);
  const indexed = createSpeechCutSelector(source);
  for (const candidate of [{ start: 8, end: 10, text: "" }, { start: 22, end: 27, text: "" }, { start: 29, end: 30, text: "" }])
    assert.deepEqual(indexed(candidate), selectSpeechCuts(source, candidate));
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

test("repeat comparison uses merged source coverage and source language rather than hook wording", () => {
  const original = [{ start: 0, end: 10 }];
  const repeated = [
    { start: 5, end: 10 },
    { start: 0, end: 6 },
    { start: 0, end: 6 },
  ];
  const before = structuredClone(repeated);
  assert.equal(footageOverlap(original, repeated), 1);
  assert.deepEqual(
    repeated,
    before,
    "Comparing plans never mutates saved cuts",
  );
  assert.equal(footageOverlap(original, [{ start: 20, end: 30 }]), 0);
  assert.equal(footageOverlap([], []), 0);
  const prior = [
    { cuts: original, text: "Adjust the shutter speed for slow motion." },
  ];
  assert.equal(
    isRepeatedPlan(
      { cuts: repeated, text: "Adjust shutter speed for slow motion!" },
      prior,
    ),
    true,
  );
  assert.equal(
    isRepeatedPlan(
      {
        cuts: repeated,
        text: "Balance microphone levels before recording dialogue.",
      },
      prior,
    ),
    false,
    "Overlapping footage alone does not establish repeated spoken ideas",
  );
  assert.equal(isRepeatedPlan({ cuts: repeated }, [{ cuts: original }]), true);
});

function autoJob(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: "current-job",
    sourceId: "source-a",
    sourceName: "source.mp4",
    variant: 2,
    batchId: "batch-a",
    status: "queued",
    progress: 0,
    settings: { ...DEFAULT_SETTINGS },
    auto: { ...DEFAULT_AUTO_OPTIONS },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("only successful automatic siblings reserve an edit, so failures and retries remain usable", () => {
  const current = autoJob();
  const accepted = autoJob({ id: "accepted", status: "completed" });
  const previous = [
    accepted,
    autoJob({ status: "completed" }),
    autoJob({ id: "failed", status: "failed" }),
    autoJob({ id: "cancelled", status: "cancelled" }),
    autoJob({ id: "queued", status: "queued" }),
    autoJob({ id: "processing", status: "processing" }),
    autoJob({ id: "other-source", status: "completed", sourceId: "source-b" }),
    autoJob({ id: "other-batch", status: "completed", batchId: "batch-b" }),
    autoJob({ id: "manual", status: "completed", auto: undefined }),
  ];
  assert.deepEqual(completedAutoSiblings(current, previous), [accepted]);
  assert.deepEqual(
    completedAutoSiblings(
      current,
      previous.filter((job) => job.id !== accepted.id),
    ),
    [],
  );
});

test("short spoken and silent sources produce no duplicate candidate after a completed edit", async () => {
  const input = transcript(
    [speech(1, ["A", "complete", "existing", "story."])],
    20,
  );
  const first = buildCandidates(input, 20, 45, 0)[0]!;
  const prior = [{ cuts: selectSpeechCuts(input, first), text: first.text }];
  for (let variant = 1; variant < MAX_AUTO_VERSIONS; variant++) {
    assert.deepEqual(buildCandidates(input, 20, 45, variant, prior), []);
    assert.deepEqual(
      sceneCuts([4, 8, 12, 16], 20, 45, variant, [
        { cuts: [{ start: 0, end: 20 }] },
      ]),
      [],
    );
  }
  // Even a first narration shortened to five seconds must not cause extra
  // versions of the same short source. This exits before any media/AI work.
  const source = {
    id: "source-a",
    name: "source.mp4",
    size: 1,
    duration: 20,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    createdAt: "2026-01-01T00:00:00Z",
    thumbnailUrl: "",
    url: "",
    filePath: "/nonexistent-source",
    thumbnailPath: "/nonexistent-thumbnail",
  };
  await assert.rejects(
    prepareAutoRemix({
      source,
      job: { ...autoJob(), outputPath: "/nonexistent-output" },
      previous: [
        autoJob({
          id: "completed",
          status: "completed",
          settings: {
            ...DEFAULT_SETTINGS,
            segments: [{ start: 0, end: 5 }],
            hookText: "An entirely new headline",
          },
        }),
      ],
      workDir: "/nonexistent-work",
      signal: new AbortController().signal,
      onPhase: () =>
        assert.fail("Duplicate was not rejected before media processing"),
    }),
    (error) =>
      error instanceof AutoSkipError &&
      /batch already has a version/u.test(error.message),
  );
});

test("history never blocks a short source from entering normal planning in another batch", async () => {
  const input = transcript([speech(1, ["A", "fresh", "complete", "story."])], 20);
  const partialHistory = [{ cuts: [{ start: 12, end: 14 }], text: "An unrelated partial excerpt" }];
  assert.ok(buildCandidates(input, 20, 45, 0, partialHistory).length > 0);
  assert.deepEqual(sceneCuts([], 20, 45, 0, partialHistory), [{ start: 0, end: 20 }]);
  const source = {
    id: "source-a", name: "source.mp4", size: 1, duration: 20,
    width: 1920, height: 1080, fps: 30, hasAudio: true,
    createdAt: "2026-01-01T00:00:00Z", thumbnailUrl: "", url: "",
    filePath: "/nonexistent-source", thumbnailPath: "/nonexistent-thumbnail",
  };
  const enteredPlanning = new Error("The historical excerpt allows normal planning");
  await assert.rejects(prepareAutoRemix({
    source, job: { ...autoJob(), outputPath: "/nonexistent-output" },
    previous: [], historyPlans: partialHistory, workDir: "/nonexistent-work",
    signal: new AbortController().signal,
    onPhase: () => { throw enteredPlanning; },
  }), error => error === enteredPlanning);
  await assert.rejects(prepareAutoRemix({
    source, job: { ...autoJob(), outputPath: "/nonexistent-output" },
    previous: [], historyPlans: [{ cuts: [{ start: 0, end: 16 }] }], workDir: "/nonexistent-work",
    signal: new AbortController().signal,
    onPhase: () => { throw enteredPlanning; },
  }), error => error === enteredPlanning);
});

test("unidentified legacy Auto sources cannot race identical content before fingerprints resolve", () => {
  const queued = autoJob({ id: "queued", sourceId: "source-b", status: "queued" });
  const running = autoJob({ id: "running", sourceId: "source-a", status: "processing" });
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a" }, { id: "source-b" }]), true);
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a", fingerprint: "same" }, { id: "source-b" }]), true);
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a" }, { id: "source-b", fingerprint: "same" }]), true);
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a", fingerprint: "same" }, { id: "source-b", fingerprint: "same" }]), true);
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a", fingerprint: "first" }, { id: "source-b", fingerprint: "second" }]), false);
  assert.equal(autoSourceBusy(queued, [{ ...running, status: "completed" }], [{ id: "source-a" }, { id: "source-b" }]), false);
  assert.equal(autoSourceBusy(queued, [{ ...running, auto: undefined }], [{ id: "source-a" }, { id: "source-b" }]), false);
  assert.equal(autoSourceBusy({ ...queued, auto: undefined }, [running], [{ id: "source-a" }, { id: "source-b" }]), false);
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a", fingerprint: "same" }, { id: "source-b", fingerprint: "same" }], new Set([running.id])), true);
  assert.equal(autoSourceBusy(queued, [running], [{ id: "source-a", fingerprint: "same" }, { id: "source-b", fingerprint: "same" }], new Set()), false,
    "Selected source cuts release the lock before stock, editorial review and rendering");
});

test("completed spoken cuts are removed before model selection while fresh long-video ideas remain", () => {
  const input = transcript(
    Array.from({ length: 24 }, (_, index) =>
      speech(index * 5 + 0.2, [
        `Topic${index}`,
        "has",
        "a",
        "specific",
        "lesson.",
      ]),
    ),
    120,
  );
  const used: EditorialPlan[] = [];
  for (let variant = 0; variant < 5; variant++) {
    const candidates = buildCandidates(input, 120, 15, 0, used);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates)
      assert.equal(
        isRepeatedPlan(
          { cuts: selectSpeechCuts(input, candidate), text: candidate.text },
          used,
        ),
        false,
      );
    const selected = candidates[0]!;
    used.push({ cuts: selectSpeechCuts(input, selected), text: selected.text });
  }
  assert.equal(new Set(used.map((plan) => JSON.stringify(plan.cuts))).size, 5);
  assert.deepEqual(
    buildCandidates(input, 120, 15, 0),
    buildCandidates(input, 120, 15, 0, []),
  );
});

test("long silent footage selects a fresh scene plan and stops when only repeats remain", () => {
  const used: EditorialPlan[] = [{ cuts: [{ start: 0, end: 30 }] }];
  const next = sceneCuts([30, 60, 90], 120, 30, 0, used);
  assert.deepEqual(next, [{ start: 30, end: 60 }]);
  used.push({ cuts: next });
  assert.deepEqual(sceneCuts([30, 60, 90], 120, 30, 0, used), [
    { start: 60, end: 90 },
  ]);
  const almostFull = [{ cuts: [{ start: 0, end: 45 }] }];
  assert.deepEqual(sceneCuts([], 50, 45, 0, almostFull), []);
});

test("one long scene supports ten distinct cuts and searches all unused positions", () => {
  const used: EditorialPlan[] = [];
  for (let variant = 0; variant < 10; variant++) {
    const cuts = sceneCuts([], 600, 30, variant, used);
    assert.equal(cuts.length, 1, `Version ${variant + 1} needs a fresh excerpt`);
    assert.ok(Math.abs(cutsDuration(cuts) - 30) < 1e-8);
    assert.ok(cuts[0]!.start >= 0 && cuts[0]!.end <= 600);
    assert.equal(isRepeatedPlan({ cuts }, used), false);
    assert.ok(used.every(previous => footageOverlap(cuts, previous.cuts) === 0));
    used.push({ cuts });
  }
  assert.equal(new Set(used.map(plan => JSON.stringify(plan.cuts))).size, 10);
  assert.deepEqual(sceneCuts([], 600, 30, 0, used.slice(0, 9)), used[9]!.cuts,
    "Earlier exports cannot hide the tenth available position");
  assert.deepEqual(sceneCuts([], 600, 30, 0, used), [],
    "Exhausted positions are skipped instead of producing a repeated cut");
});

test("key-point overlays follow matching edited speech and omit unmatched or overlapping copy", () => {
  const input = transcript(
    [
      speech(0, ["Welcome", "to", "this", "short", "lesson."]),
      speech(8, [
        "Adjust",
        "the",
        "shutter",
        "speed",
        "for",
        "slow",
        "motion.",
      ]),
      speech(20, ["Balance", "microphone", "levels", "before", "recording."]),
    ],
    30,
  );
  const callouts = alignCallouts(
    ["Shutter speed", "Microphone levels"],
    input,
    30,
  );
  assert.equal(callouts.length, 2);
  assert.ok(callouts[0]!.start >= 8.5 && callouts[0]!.start < 9);
  assert.ok(callouts[1]!.start >= 20 && callouts[1]!.start < 21);
  assert.deepEqual(
    alignCallouts(["Guaranteed incredible earnings"], input, 30),
    [],
  );
  assert.equal(
    alignCallouts(["Shutter speed", "Speed for slow motion"], input, 30).length,
    1,
  );
  assert.deepEqual(alignCallouts(["Shutter speed"], transcript([]), 30), []);
});
