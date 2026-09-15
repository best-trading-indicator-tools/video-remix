import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type EditPlan, type EditPlanChanges, type Transcript } from "../shared/types.js";
import { applyEditPlanChanges, captionCuesSrt, editPlanChangesSchema, parseCaptionCues } from "../server/edit-plan.js";
import { textLayoutIssues } from "../shared/framing.js";

const makePlan = (): EditPlan => ({
  version: 1,
  revision: 3,
  sourceId: "source-original",
  sourceDuration: 30,
  outputDuration: 10,
  createdAt: "2026-09-15T12:00:00.000Z",
  settings: {
    ...DEFAULT_SETTINGS,
    hookText: "Original opening",
    hookDuration: 3,
    trimStart: 0,
    trimEnd: 15,
    segments: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    callouts: [{ text: "First idea", start: 1, end: 2 }, { text: "Last idea", start: 8, end: 9 }],
  },
  cuts: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
  captions: [
    { id: "caption-1", start: 1, end: 2, text: "The corrected first phrase." },
    { id: "caption-2", start: 6, end: 7, text: "The second phrase." },
  ],
  visuals: [{ id: "visual-1", mediaId: "media:one", start: 6, end: 8, sourceStart: 1.4, locked: true, enabled: true, reason: "Shows the spoken example" }],
  media: [
    { id: "media:one", name: "Chosen moving stock", kind: "broll", duration: 8, url: "/api/edits/media/one", attribution: { provider: "Pixabay", creator: "Test creator", url: "https://pixabay.com/videos/id-1/" } },
    { id: "media:two", name: "Alternative moving stock", kind: "broll", duration: 8 },
    { id: "audio:one", name: "Saved narration", kind: "audio", duration: 10 },
  ],
  narration: false,
});
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test("framing-only corrections preserve source timing, corrected captions and locked media", () => {
  const plan = deepFreeze(makePlan());
  const cuts = plan.cuts.map(cut => ({ ...cut, focalPoint: { x: 0.1, y: 0.8 } }));
  const framing = { fit: "crop" as const, focalPoint: { x: 0.5, y: 0.5 }, captionStyle: { fontSize: 18, bottomPercent: 20 } };
  const next = applyEditPlanChanges(plan, { revision: plan.revision, cuts, framing }, {
    language: "en", duration: 30, segments: [{ start: 1, end: 2, text: "Uncorrected ASR text", words: [] }],
  });
  assert.deepEqual(next.captions, plan.captions);
  assert.deepEqual(next.visuals, plan.visuals);
  assert.deepEqual(next.settings.callouts, plan.settings.callouts);
  assert.deepEqual(next.cuts, cuts);
  assert.equal(next.outputDuration, plan.outputDuration);
  assert.deepEqual(next.settings.captionStyle, framing.captionStyle);
  assert.equal(plan.settings.captionStyle, undefined);
  for (const invalid of [
    { framing: { focalPoint: { x: 2, y: 0.5 } } },
    { framing: { captionStyle: { fontSize: 41, bottomPercent: 20 } } },
    { cuts: [{ start: 0, end: 2, focalPoint: { x: 0.5, y: -1 } }] },
    { framing: { arbitraryPath: "/tmp/private" } },
  ]) assert.equal(editPlanChangesSchema.safeParse({ revision: plan.revision, ...invalid }).success, false);
  const visual = { ...plan.visuals[0]!, focalPoint: { x: 0.2, y: 0.6 } };
  assert.throws(() => applyEditPlanChanges(plan, { revision: plan.revision, visuals: [visual] }), /Unlock/u);
  const unlocked = applyEditPlanChanges(plan, { revision: plan.revision, visuals: [{ ...visual, locked: false }] });
  assert.deepEqual(unlocked.visuals[0]!.focalPoint, visual.focalPoint);
});

test("text checks flag simultaneous collisions and offscreen text, with clear times", () => {
  const plan = makePlan();
  plan.settings.aspect = "16:9";
  plan.settings.callouts = [];
  plan.settings.captionStyle = { fontSize: 40, bottomPercent: 70 };
  const issues = textLayoutIssues(plan);
  assert.ok(issues.some(issue => issue.code === "text-collision" && issue.start === 1 && issue.end === 2));
  plan.settings.captionStyle = { fontSize: 18, bottomPercent: 20 };
  assert.deepEqual(textLayoutIssues(plan), []);
  plan.settings.captionStyle = { fontSize: 40, bottomPercent: 80 };
  plan.captions[0]!.text = "A very long caption ".repeat(25);
  assert.ok(textLayoutIssues(plan).some(issue => issue.code === "text-bounds"));
  plan.settings.captionStyle = { fontSize: 20, bottomPercent: 50 };
  plan.settings.aspect = "original";
  plan.settings.hookText = "";
  plan.captions = [{ id: "portrait", start: 1, end: 2, text: "A longer phrase that wraps onto many lines in a narrow portrait video and needs a lower position" }];
  assert.ok(textLayoutIssues(plan, 9 / 16).some(issue => issue.code === "text-bounds"));
  assert.deepEqual(textLayoutIssues(plan, 16 / 9), []);
  plan.settings.hookText = Array(5).fill("abcdefghijklm").join(" ");
  plan.settings.callouts = [{ start: 0, end: 2, text: "Example" }];
  plan.captions = [];
  assert.ok(textLayoutIssues(plan, 9 / 16).some(issue => issue.code === "text-collision"));
});

test("hook and caption corrections preserve saved choices and leave the original revision immutable", () => {
  const plan = deepFreeze(makePlan());
  const before = JSON.stringify(plan);
  const hook = applyEditPlanChanges(plan, { revision: 3, hookText: "A clearer opening" });
  assert.equal(hook.revision, 4);
  assert.equal(hook.settings.hookText, "A clearer opening");
  assert.deepEqual(hook.cuts, plan.cuts);
  assert.deepEqual(hook.captions, plan.captions);
  assert.deepEqual(hook.visuals, plan.visuals);
  assert.deepEqual(hook.media, plan.media);
  assert.notEqual(hook.media, plan.media);
  assert.equal(hook.outputDuration, plan.outputDuration);
  const corrected = applyEditPlanChanges(plan, { revision: 3, captions: plan.captions.map(cue => ({ ...cue, text: cue.id === "caption-2" ? "The corrected second phrase." : cue.text })) });
  assert.equal(corrected.captions[1]!.text, "The corrected second phrase.");
  assert.deepEqual(corrected.visuals, plan.visuals);
  assert.deepEqual(corrected.settings, plan.settings);
  assert.equal(JSON.stringify(plan), before);
});

test("shortening cuts retimes complete captions, callouts and locked shots while dropping clipped phrases", () => {
  const plan = makePlan();
  plan.captions.unshift({ id: "clipped-phrase", start: 0.2, end: 0.8, text: "These words were removed." });
  plan.captions.push({ id: "partially-clipped", start: 8, end: 9.5, text: "Never copy a whole phrase onto missing footage." });
  const cuts = [{ start: 1, end: 5 }, { start: 10, end: 13 }];
  const next = applyEditPlanChanges(plan, { revision: 3, cuts });
  assert.equal(next.outputDuration, 7);
  assert.deepEqual(next.settings.segments, cuts);
  assert.equal(next.settings.trimStart, 1);
  assert.equal(next.settings.trimEnd, 13);
  assert.deepEqual(next.captions, [
    { ...plan.captions[1]!, start: 0, end: 1 },
    { ...plan.captions[2]!, start: 5, end: 6 },
  ]);
  assert.deepEqual(next.settings.callouts, [{ text: "First idea", start: 0, end: 1 }]);
  assert.deepEqual(next.visuals, [{ ...plan.visuals[0]!, start: 5, end: 7 }]);
  assert.deepEqual(next.media, plan.media);
  assert.equal(next.settings.hookText, plan.settings.hookText);
});

test("cut reordering and playback speed map source time correctly across joined boundaries", () => {
  const plan = makePlan();
  plan.settings.speed = 2;
  plan.outputDuration = 5;
  plan.captions = [{ id: "boundary", start: 2, end: 3, text: "Speech across the two cuts" }];
  plan.visuals = [];
  plan.settings.callouts = [];
  const reordered = applyEditPlanChanges(plan, { revision: 3, cuts: [{ start: 10, end: 15 }, { start: 0, end: 5 }] });
  assert.deepEqual(reordered.captions, [], "The old source sequence no longer occurs contiguously");
  const split = applyEditPlanChanges(plan, { revision: 3, cuts: [{ start: 0, end: 2 }, { start: 2, end: 5 }, { start: 10, end: 15 }] });
  assert.deepEqual(split.captions, plan.captions, "Splitting a retained source interval does not delete its caption");
});

test("source transcript regenerates newly included speech while preserving corrections at retained timings", () => {
  const plan = makePlan();
  const sourceTranscript: Transcript = {
    language: "en", duration: 30,
    segments: [
      { start: 1, end: 2, text: "The initial phrase.", words: [{ start: 1, end: 1.2, word: "The" }, { start: 1.2, end: 1.5, word: "initial" }, { start: 1.5, end: 2, word: "phrase." }] },
      { start: 16, end: 17, text: "A new example.", words: [{ start: 16, end: 16.2, word: "A" }, { start: 16.2, end: 16.5, word: "new" }, { start: 16.5, end: 17, word: "example." }] },
    ],
  };
  const next = applyEditPlanChanges(plan, { revision: 3, cuts: [{ start: 0, end: 5 }, { start: 15, end: 20 }] }, sourceTranscript);
  assert.deepEqual(next.captions[0], plan.captions[0]);
  assert.equal(next.captions[1]!.text, "A new example.");
  assert.equal(next.captions[1]!.start, 6);
  assert.equal(next.captions[1]!.end, 7);
  assert.deepEqual(next.visuals, [], "A shot anchored to excluded speech is removed");
});

const captionPolicyTranscript: Transcript = {
  language: "en", duration: 30, segments: [
    { start: 1, end: 2, text: "Original phrase.", words: [
      { start: 1, end: 1.5, word: "Original" }, { start: 1.5, end: 2, word: "phrase." },
    ] },
    { start: 16, end: 17, text: "New example.", words: [
      { start: 16, end: 16.5, word: "New" }, { start: 16.5, end: 17, word: "example." },
    ] },
  ],
};

test("Auto caption omission survives saved-plan reloads and recuts despite available speech", () => {
  const plan = makePlan();
  plan.captions = [];
  plan.captionMode = "off";
  const saved: EditPlan = JSON.parse(JSON.stringify(plan));
  const next = applyEditPlanChanges(saved, { revision: saved.revision,
    cuts: [{ start: 0, end: 5 }, { start: 15, end: 20 }],
  }, captionPolicyTranscript);
  assert.deepEqual(next.captions, [], "Newly selected speech must not put a second caption layer over the source");
  assert.equal(next.captionMode, "off");
  const reordered = applyEditPlanChanges(next, { revision: next.revision,
    cuts: [{ start: 15, end: 20 }, { start: 0, end: 5 }],
  }, captionPolicyTranscript);
  assert.deepEqual(reordered.captions, []);
  assert.equal(reordered.captionMode, "off");
  assert.deepEqual(saved, plan, "Applying changes must preserve the saved omission decision");
});

test("removing all captions persists through recuts until an explicit caption addition re-enables them", () => {
  const plan = makePlan();
  plan.captionMode = "generated";
  const removed = applyEditPlanChanges(plan, { revision: plan.revision, captions: [] }, captionPolicyTranscript);
  assert.equal(removed.captionMode, "off");
  const recut = applyEditPlanChanges(removed, { revision: removed.revision,
    cuts: [{ start: 0, end: 5 }, { start: 15, end: 20 }],
  }, captionPolicyTranscript);
  assert.deepEqual(recut.captions, []);
  assert.equal(recut.captionMode, "off");
  const correctedCue = { id: "explicit-caption", start: 1, end: 2, text: "A user-corrected phrase." };
  const added = applyEditPlanChanges(recut, { revision: recut.revision, captions: [correctedCue] }, captionPolicyTranscript);
  assert.equal(added.captionMode, "generated");
  const extended = applyEditPlanChanges(added, { revision: added.revision,
    cuts: [{ start: 0, end: 5 }, { start: 15, end: 21 }],
  }, captionPolicyTranscript);
  assert.deepEqual(extended.captions[0], correctedCue, "An explicit correction remains authoritative");
  assert.deepEqual(extended.captions.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 1, end: 2, text: correctedCue.text }, { start: 6, end: 7, text: "New example." },
  ]);
  assert.equal(extended.captionMode, "generated");
});

test("transcript regrouping preserves a complete corrected cue and fills only uncovered timed words", () => {
  const plan = makePlan();
  plan.captions = [{ id: "manual-phrase", start: 1, end: 2, text: "My corrected words" }];
  plan.visuals = [];
  plan.settings.callouts = [];
  const sourceTranscript: Transcript = {
    language: "en", duration: 30,
    segments: [{ start: 0.5, end: 2.5, text: "Before old words after", words: [
      { start: 0.5, end: 0.9, word: "Before" },
      { start: 1, end: 1.4, word: "old" },
      { start: 1.5, end: 2, word: "words" },
      { start: 2.1, end: 2.5, word: "after" },
    ] }],
  };
  const next = applyEditPlanChanges(plan, { revision: 3, cuts: [{ start: 0, end: 4 }] }, sourceTranscript);
  assert.deepEqual(next.captions.map(cue => cue.text), ["Before", "My corrected words", "after"]);
  assert.deepEqual(next.captions[1], plan.captions[0]);
});

test("locked shots require an explicit unlock for swaps and timing changes, and can be disabled", () => {
  const plan = makePlan();
  const shot = plan.visuals[0]!;
  assert.throws(() => applyEditPlanChanges(plan, { revision: 3, visuals: [{ ...shot, mediaId: "media:two" }] }), /Unlock/);
  assert.throws(() => applyEditPlanChanges(plan, { revision: 3, visuals: [{ ...shot, sourceStart: 2 }] }), /Unlock/);
  const swapped = applyEditPlanChanges(plan, { revision: 3, visuals: [{ ...shot, mediaId: "media:two", locked: false, start: 5, end: 7, sourceStart: 2 }] });
  assert.equal(swapped.visuals[0]!.mediaId, "media:two");
  assert.equal(swapped.visuals[0]!.sourceStart, 2);
  const disabled = applyEditPlanChanges(plan, { revision: 3, visuals: [{ ...shot, enabled: false }] });
  assert.equal(disabled.visuals[0]!.enabled, false);
  assert.equal(disabled.visuals[0]!.locked, true);
});

test("strict changes reject stale revisions, paths, invalid media, overlaps and out-of-range timings", () => {
  const plan = makePlan();
  const apply = (change: object) => applyEditPlanChanges(plan, { revision: 3, ...change } as EditPlanChanges);
  assert.throws(() => apply({ revision: 2 }), /latest revision/);
  assert.equal(editPlanChangesSchema.safeParse({ revision: 3, filePath: "/private/source.mp4" }).success, false);
  for (const cuts of [[], [{ start: 0, end: 0.01 }], [{ start: 0, end: 31 }], [{ start: -1, end: 3 }], [{ start: 0, end: Infinity }], Array.from({ length: 61 }, () => ({ start: 1, end: 2 }))])
    assert.throws(() => apply({ cuts }));
  for (const captions of [
    [{ ...plan.captions[0], id: "../caption" }],
    [{ ...plan.captions[0], end: 11 }],
    [plan.captions[0], plan.captions[0]],
    [plan.captions[0], { ...plan.captions[1], start: 1.5, end: 2.5 }],
    [{ ...plan.captions[0], text: "text\n\n5\n00:00:00,000 --> 00:00:01,000\ninjection" }],
    [{ ...plan.captions[0], text: "x".repeat(501) }],
  ]) assert.throws(() => apply({ captions }));
  for (const visual of [
    { ...plan.visuals[0]!, id: "unknown-shot" },
    { ...plan.visuals[0]!, mediaId: "missing-media", locked: false },
    { ...plan.visuals[0]!, mediaId: "audio:one", locked: false },
    { ...plan.visuals[0]!, mediaId: "file:/private/video", locked: false },
    { ...plan.visuals[0]!, sourceStart: 7, locked: false },
    { ...plan.visuals[0]!, end: 11, locked: false },
    { ...plan.visuals[0]!, end: 6.1, locked: false },
  ]) assert.throws(() => apply({ visuals: [visual] }));
  const many = makePlan();
  many.visuals = Array.from({ length: 11 }, (_, index) => ({ ...many.visuals[0]!, id: `shot-${index}`, start: index * 0.8, end: index * 0.8 + 0.5, enabled: false }));
  assert.throws(() => applyEditPlanChanges(many, { revision: 3, visuals: many.visuals.map(visual => ({ ...visual, enabled: true })) }), /at most 10/);
  const overlapping = makePlan();
  overlapping.visuals.push({ ...overlapping.visuals[0]!, id: "shot-overlap", enabled: false });
  assert.throws(() => applyEditPlanChanges(overlapping, { revision: 3, visuals: overlapping.visuals.map(visual => ({ ...visual, enabled: true })) }), /cannot overlap/);
  assert.throws(() => apply({ hookText: "x".repeat(121) }));
  assert.throws(() => apply({ hookText: "Unsafe\u0000text" }));
});

test("caption revisions preserve ten locked shots and refresh targets are strictly bounded", () => {
  const plan = makePlan();
  plan.visuals = Array.from({ length: 10 }, (_, index) => ({ ...plan.visuals[0]!, id: `shot-${index}`, start: index * 0.9, end: index * 0.9 + 0.5 }));
  const next = applyEditPlanChanges(plan, { revision: 3, captions: plan.captions.map(cue => ({ ...cue, text: "Corrected text." })) });
  assert.deepEqual(next.visuals, plan.visuals);
  assert.equal(next.visuals.length, 10);
  assert.equal(next.revision, 4);
  for (const brollCount of [0, 11, 2.5, "5", NaN]) assert.equal(editPlanChangesSchema.safeParse({ revision: 3, refreshBroll: true, brollCount }).success, false);
  assert.throws(() => applyEditPlanChanges(plan, { revision: 3, brollCount: 5 }), /new stock search/);
  assert.deepEqual(applyEditPlanChanges(plan, { revision: 3, refreshBroll: true, brollCount: 10 }).visuals, plan.visuals);
});

test("locked narration keeps its audio timeline and rejects edits that change total duration", () => {
  const plan = makePlan();
  plan.narration = true;
  plan.audioMediaId = "audio:one";
  assert.throws(() => applyEditPlanChanges(plan, { revision: 3, cuts: [{ start: 0, end: 3 }] }), /Narration audio is locked/);
  const next = applyEditPlanChanges(plan, { revision: 3, cuts: [{ start: 15, end: 25 }] });
  assert.deepEqual(next.captions, plan.captions);
  assert.deepEqual(next.settings.callouts, plan.settings.callouts);
  assert.deepEqual(next.visuals, plan.visuals);
  assert.deepEqual(next.media, plan.media);
  assert.equal(next.audioMediaId, plan.audioMediaId);
});

test("SRT canonicalization safely round-trips multilingual caption text and rejects alternate file syntax", () => {
  const parsed = parseCaptionCues("\uFEFF8\r\n00:00:01.000 --> 00:00:02.100\r\nDon't lose 50%: café 中文.\r\nA second line.\r\n\r\n9\r\n00:00:02,100 --> 00:00:03,000\r\nThe end.\r\n");
  const canonical = captionCuesSrt(parsed);
  assert.match(canonical, /^1\n00:00:01,000 --> 00:00:02,100\n/u);
  assert.deepEqual(parseCaptionCues(canonical), parsed);
  assert.equal(captionCuesSrt([]), "");
  assert.deepEqual(parseCaptionCues("\n"), []);
  for (const invalid of [
    "#EXTM3U\nfile:///private/video.mp4",
    "1\n00:60:00,000 --> 00:61:00,000\nText",
    "1\n00:00:02,000 --> 00:00:01,000\nText",
    "1\n00:00:00,000 --> 00:00:01,000\n{\\an8}Markup",
    "1\n00:00:00,000 --> 00:00:01,000\n<b>Markup</b>",
    "1\n00:00:00,000 --> 00:00:01,000\nUnsafe\u0000text",
  ]) assert.throws(() => parseCaptionCues(invalid));
});

test("imported ASR edge overlaps preserve both phrases while editor submissions remain strict", () => {
  const parsed = parseCaptionCues("1\n00:00:01,000 --> 00:00:02,040\nFirst phrase.\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond phrase.\n");
  assert.equal(parsed[0]!.text, "First phrase.");
  assert.equal(parsed[1]!.text, "Second phrase.");
  assert.equal(parsed[1]!.start, 2.04);
  assert.deepEqual(parseCaptionCues(captionCuesSrt(parsed)), parsed);
  assert.throws(() => applyEditPlanChanges(makePlan(), { revision: 3, captions: [parsed[0]!, { ...parsed[1]!, start: 2 }] }), /cannot overlap/);
});
