import assert from "node:assert/strict";
import { test } from "node:test";
import { clipFocusTrack, focusPointAt, MAX_FOCUS_POINTS_PER_CUT, MAX_FOCUS_POINTS_TOTAL, validFocusTrack, withTrackBounds } from "../shared/focus.js";
import { DEFAULT_SETTINGS, type EditPlan, type EditSegment, type FocusKeyframe, type VideoSource } from "../shared/types.js";
import { createShortDraft, restoreShortDrafts, shortFocusSignature, validateShortDraft, type ShortDraft } from "../shared/shorts.js";
import { settingsSchema } from "../server/schema.js";
import { applyEditPlanChanges, editPlanChangesSchema } from "../server/edit-plan.js";
import { manualPreviewSettings } from "../server/manual-preview.js";
import { proposePromptEdit } from "../server/prompt-edit.js";
import { proposeManualPrompt } from "../server/manual-prompt.js";

const fallback = { x: 0.5, y: 0.5 };
const track = (): FocusKeyframe[] => [{ time: 10, x: 0.1, y: 0.2 }, { time: 15, x: 0.6, y: 0.7 }, { time: 20, x: 0.9, y: 0.4 }];
const source = { duration: 100, width: 1920, height: 1080, fps: 30, hasAudio: true };
const videoSource = { ...source, id: "source", fingerprint: "content", name: "Interview.mp4", size: 100,
  createdAt: "", url: "/source", thumbnailUrl: "/thumbnail" } as VideoSource;
const focusedDraft = (): ShortDraft => {
  const draft = createShortDraft(videoSource, "draft", "cut", 10);
  draft.cuts[0]!.end = "00:00:20.000";
  draft.cuts[0]!.focusTrack = track();
  draft.autoFocus = true;
  draft.focusAnalysis = { signature: shortFocusSignature(draft), status: "tracked", multipleFaces: false };
  return draft;
};
const makePlan = (): EditPlan => {
  const cuts: EditSegment[] = [
    { start: 10, end: 20, focalPoint: fallback, focusTrack: track() },
    { start: 10, end: 20, focusTrack: [{ time: 10, x: 0.9, y: 0.5 }, { time: 20, x: 0.1, y: 0.5 }] },
  ];
  return { version: 1, revision: 1, sourceId: "source", sourceDuration: 100, outputDuration: 10,
    createdAt: "2026-09-16T00:00:00.000Z", settings: { ...DEFAULT_SETTINGS, speed: 2, segments: structuredClone(cuts) },
    cuts, captions: [{ id: "caption-1", start: 1, end: 2, text: "An existing caption." }],
    captionMode: "generated", visuals: [], media: [], narration: false };
};
const closePoint = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `${actual.y} != ${expected.y}`);
};

test("source focus tracks interpolate independently and hold the closest observed endpoint", () => {
  assert.deepEqual(focusPointAt(undefined, 100, fallback), fallback);
  assert.deepEqual(focusPointAt(track(), NaN, fallback), fallback);
  assert.deepEqual(focusPointAt(track(), Infinity, fallback), fallback);
  assert.deepEqual(focusPointAt(track(), 0, fallback), { x: 0.1, y: 0.2 });
  assert.deepEqual(focusPointAt(track(), 100, fallback), { x: 0.9, y: 0.4 });
  closePoint(focusPointAt(track(), 12.5, fallback), { x: 0.35, y: 0.45 });
  closePoint(focusPointAt(track(), 17.5, fallback), { x: 0.75, y: 0.55 });
  assert.deepEqual(focusPointAt([{ time: 15, x: 0.2, y: 0.3 }], 50, fallback), { x: 0.2, y: 0.3 });
  const plan = makePlan();
  assert.notDeepEqual(focusPointAt(plan.cuts[0]!.focusTrack, 12, fallback), focusPointAt(plan.cuts[1]!.focusTrack, 12, fallback), "Repeated source intervals keep their own focus choices");
});

test("trimming synthesizes exact boundary positions without changing source timestamps or inputs", () => {
  const original = track(), before = structuredClone(original);
  const clipped = clipFocusTrack(original, 12, 18)!;
  assert.deepEqual(clipped.map(point => point.time), [12, 15, 18]);
  for (const time of [12, 13, 15, 17, 18]) closePoint(focusPointAt(clipped, time, fallback), focusPointAt(original, time, fallback));
  assert.deepEqual(original, before);
  assert.deepEqual(clipFocusTrack(original, 1, 8), [{ time: 1, x: 0.1, y: 0.2 }]);
  assert.deepEqual(clipFocusTrack(original, 22, 30), [{ time: 22, x: 0.9, y: 0.4 }]);
  assert.deepEqual(clipFocusTrack(undefined, 0, 5), undefined);
  const invalid = { start: NaN, end: 20, focusTrack: original };
  assert.deepEqual(withTrackBounds(invalid), invalid, "An unfinished timestamp remains invalid and editable instead of crashing");
  const extended = withTrackBounds({ start: 8, end: 23, focusTrack: original });
  assert.deepEqual(extended.focusTrack, original, "Extensions hold endpoints without adding unknown motion");
  closePoint(focusPointAt(extended.focusTrack, 8, fallback), { x: 0.1, y: 0.2 });
});

test("short analysis identity follows source, ordered cuts and starting focus but survives visual export changes", () => {
  const draft = focusedDraft(), signature = shortFocusSignature(draft);
  for (const patch of [{ title: "Renamed" }, { zoom: 1.6 }, { aspect: "1:1" as const }, { resolution: "720" as const }, { autoFocus: false }])
    assert.equal(shortFocusSignature({ ...draft, ...patch }), signature);
  for (const changed of [
    { ...draft, sourceId: "reimport" }, { ...draft, focalPoint: { x: 0.2, y: 0.8 } },
    { ...draft, cuts: [{ ...draft.cuts[0]!, start: "00:00:11.000" }] },
    { ...draft, cuts: [{ ...draft.cuts[0]!, end: "00:00:19.000" }] },
    { ...draft, cuts: [{ ...draft.cuts[0]!, id: "other-occurrence" }] },
  ]) assert.notEqual(shortFocusSignature(changed), signature);
  const two = { ...draft, cuts: [draft.cuts[0]!, { ...draft.cuts[0]!, id: "second", start: "00:00:30.000", end: "00:00:40.000" }] };
  assert.notEqual(shortFocusSignature(two), shortFocusSignature({ ...two, cuts: [...two.cuts].reverse() }));
});

test("short draft restore keeps valid tracks and invalidates incomplete or oversized saved analysis", () => {
  const draft = focusedDraft();
  const restored = restoreShortDrafts(JSON.parse(JSON.stringify({ version: 1, drafts: [draft] })))[0]!;
  assert.deepEqual(restored.cuts, draft.cuts);
  assert.deepEqual(restored.focusAnalysis, { ...draft.focusAnalysis, reason: undefined });
  assert.equal(restored.autoFocus, true);
  assert.deepEqual(validateShortDraft(restored, videoSource).errors, []);
  for (const invalidTrack of [[], [{ time: 0, x: 0.5, y: 0.5 }], [{ time: 12, x: 5, y: 0.5 }]]) {
    const invalid = { ...draft, cuts: [{ ...draft.cuts[0]!, focusTrack: invalidTrack }] };
    const restoredInvalid = restoreShortDrafts({ version: 1, drafts: [invalid] })[0]!;
    assert.equal(restoredInvalid.cuts[0]!.focusTrack, undefined);
    assert.equal(restoredInvalid.focusAnalysis, undefined);
    assert.equal(validateShortDraft(restoredInvalid, videoSource).settings, null, "Invalid saved tracking needs another analysis");
  }
  const points = Array.from({ length: 120 }, (_, index) => ({ time: 10 + index / 12, x: 0.5, y: 0.5 }));
  const oversized = { ...draft, cuts: [0, 1, 2].map(index => ({ ...draft.cuts[0]!, id: String(index), focusTrack: points })) };
  oversized.focusAnalysis = { ...draft.focusAnalysis!, signature: shortFocusSignature(oversized) };
  const restoredOversized = restoreShortDrafts({ version: 1, drafts: [oversized] })[0]!;
  assert.equal(restoredOversized.focusAnalysis, undefined);
  assert.equal(validateShortDraft(restoredOversized, videoSource).settings, null);
});

test("short tracking only reaches render settings when enabled, applicable and analyzed for the current cuts", () => {
  const draft = focusedDraft();
  assert.deepEqual(validateShortDraft(draft, videoSource).settings!.segments![0]!.focusTrack, track());
  for (const changed of [{ ...draft, autoFocus: false }, { ...draft, fit: "contain" as const }, { ...draft, fit: "blur" as const }]) {
    const validated = validateShortDraft(changed, videoSource);
    assert.deepEqual(validated.errors, []);
    assert.equal(validated.settings!.segments![0]!.focusTrack, undefined);
  }
  assert.equal(validateShortDraft({ ...draft, focusAnalysis: undefined }, videoSource).settings, null);
  assert.equal(validateShortDraft({ ...draft, focalPoint: { x: 0.3, y: 0.5 } }, videoSource).settings, null);
  for (const status of ["no-face", "unavailable"] as const) {
    const noTrack = { ...draft, cuts: draft.cuts.map(({ focusTrack: _track, ...cut }) => cut),
      focusAnalysis: { ...draft.focusAnalysis!, status } };
    const validated = validateShortDraft(noTrack, videoSource);
    assert.deepEqual(validated.errors, []);
    assert.equal(validated.settings!.segments![0]!.focusTrack, undefined, "An honest no-match result uses the manual crop");
  }
});

test("request schemas retain source tracks and reject invalid clocks, coordinates, order and oversized trajectories", () => {
  const settings = makePlan().settings;
  assert.deepEqual(settingsSchema.parse(settings).segments, settings.segments);
  assert.deepEqual(editPlanChangesSchema.parse({ revision: 1, cuts: settings.segments }).cuts, settings.segments);
  for (const invalid of [[], [{ time: 9, x: 0.5, y: 0.5 }], [{ time: 21, x: 0.5, y: 0.5 }],
    [{ time: 10, x: -0.1, y: 0.5 }], [{ time: 10, x: 0.5, y: 1.1 }], [{ time: NaN, x: 0.5, y: 0.5 }],
    [{ time: 10, x: 0.5, y: 0.5 }, { time: 10, x: 0.6, y: 0.5 }],
    [{ time: 20, x: 0.5, y: 0.5 }, { time: 10, x: 0.6, y: 0.5 }],
  ]) {
    assert.equal(validFocusTrack(invalid, 10, 20), false);
    const cuts = [{ start: 10, end: 20, focusTrack: invalid }];
    assert.equal(settingsSchema.safeParse({ ...settings, segments: cuts }).success, false);
    assert.equal(editPlanChangesSchema.safeParse({ revision: 1, cuts }).success, false);
  }
  const points = (count: number) => Array.from({ length: count }, (_, time) => ({ time, x: 0.5, y: 0.5 }));
  const cut = { start: 0, end: 200, focusTrack: points(MAX_FOCUS_POINTS_PER_CUT) };
  assert.equal(settingsSchema.safeParse({ ...settings, segments: [cut, cut] }).success, true);
  assert.equal(MAX_FOCUS_POINTS_TOTAL, MAX_FOCUS_POINTS_PER_CUT * 2);
  for (const segments of [{ ...cut, focusTrack: points(MAX_FOCUS_POINTS_PER_CUT + 1) }].map(value => [value]).concat([[cut, cut, { start: 0, end: 1, focusTrack: points(1) }]])) {
    assert.equal(settingsSchema.safeParse({ ...settings, segments }).success, false);
    assert.equal(editPlanChangesSchema.safeParse({ revision: 1, cuts: segments }).success, false);
  }
});

test("five-second previews retain source-clock motion at normal and faster speeds", () => {
  for (const speed of [1, 2]) {
    const settings = { ...DEFAULT_SETTINGS, speed, segments: [{ start: 10, end: 30,
      focusTrack: [{ time: 10, x: 0.1, y: 0.5 }, { time: 30, x: 0.9, y: 0.5 }] }] };
    const before = structuredClone(settings);
    const preview = manualPreviewSettings(settings, source);
    assert.equal(preview.duration, 5);
    assert.equal(preview.settings.segments![0]!.end, 10 + 5 * speed);
    assert.ok(settingsSchema.safeParse(preview.settings).success);
    for (const outputTime of [0, 2, 4.9]) closePoint(
      focusPointAt(preview.settings.segments![0]!.focusTrack, 10 + outputTime * speed, fallback),
      focusPointAt(settings.segments[0]!.focusTrack, 10 + outputTime * speed, fallback),
    );
    assert.deepEqual(settings, before);
  }
});

test("preview clipping crosses reordered cuts and preserves separate repeated-source trajectories", () => {
  const settings = { ...DEFAULT_SETTINGS, speed: 2, segments: [
    { start: 40, end: 44, focusTrack: [{ time: 40, x: 0.1, y: 0.5 }, { time: 44, x: 0.3, y: 0.5 }] },
    { start: 10, end: 20, focusTrack: track() },
    { start: 10, end: 20, focusTrack: [{ time: 10, x: 0.9, y: 0.5 }, { time: 20, x: 0.1, y: 0.5 }] },
  ] };
  const preview = manualPreviewSettings(settings, source).settings;
  assert.deepEqual(preview.segments!.map(({ start, end }) => ({ start, end })), [{ start: 40, end: 44 }, { start: 10, end: 16 }]);
  assert.deepEqual(preview.segments![0]!.focusTrack, settings.segments[0]!.focusTrack);
  closePoint(focusPointAt(preview.segments![1]!.focusTrack, 16, fallback), focusPointAt(track(), 16, fallback));
  const boundary = manualPreviewSettings({ ...settings, segments: [{ ...settings.segments[0]!, end: 50,
    focusTrack: [{ time: 40, x: 0.1, y: 0.5 }, { time: 50, x: 0.3, y: 0.5 }] }, settings.segments[1]!] }, source);
  assert.equal(boundary.settings.segments!.length, 1);
});

test("saved caption revisions retain trajectories while explicit focal corrections become stationary", () => {
  const plan = makePlan(), before = structuredClone(plan);
  const next = applyEditPlanChanges(plan, { revision: 1, captions: [{ ...plan.captions[0]!, text: "Corrected caption." }] });
  assert.deepEqual(next.cuts, plan.cuts);
  assert.deepEqual(next.settings.segments, plan.cuts);
  assert.deepEqual(plan, before);
  const global = applyEditPlanChanges(plan, { revision: 1, framing: { focalPoint: { x: 0.2, y: 0.8 } } });
  assert.ok(global.cuts.every(cut => !cut.focusTrack));
  assert.deepEqual(global.cuts[0]!.focalPoint, { x: 0.2, y: 0.8 });
  const one = applyEditPlanChanges(plan, { revision: 1, cuts: plan.cuts.map((cut, index) => index ? cut : { ...cut, focalPoint: { x: 0.3, y: 0.4 } }) });
  assert.equal(one.cuts[0]!.focusTrack, undefined);
  assert.deepEqual(one.cuts[1]!.focusTrack, plan.cuts[1]!.focusTrack);
  const shorter = applyEditPlanChanges(plan, { revision: 1, cuts: plan.cuts.map(cut => ({ ...cut, start: 12, end: 18 })) });
  assert.ok(shorter.cuts.every(cut => validFocusTrack(cut.focusTrack, 12, 18)));
  closePoint(focusPointAt(shorter.cuts[0]!.focusTrack, 12, fallback), focusPointAt(track(), 12, fallback));
  const repeated = makePlan(); repeated.cuts[1]!.focalPoint = { x: 0.9, y: 0.1 };
  repeated.settings.segments = structuredClone(repeated.cuts);
  const reordered = applyEditPlanChanges(repeated, { revision: 1, cuts: [...repeated.cuts].reverse() });
  assert.deepEqual(reordered.cuts, [...repeated.cuts].reverse(), "Reordering repeated intervals preserves distinct tracks and static fallbacks");
  const reorderedTrim = applyEditPlanChanges(repeated, { revision: 1, cuts: [...repeated.cuts].reverse().map(cut => ({ ...cut, start: 12, end: 18 })) });
  assert.deepEqual(reorderedTrim.cuts.map(cut => cut.focusTrack), [...repeated.cuts].reverse().map(cut => clipFocusTrack(cut.focusTrack, 12, 18)));
});

test("prompt trims preserve motion while explicit saved and manual focal requests disable tracking", async t => {
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "focus-test-no-real-provider";
  let reply: unknown = {};
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] }));
  const signal = new AbortController().signal;
  try {
    const plan = makePlan();
    reply = { operations: [{ op: "trim", start: 1, end: 8 }] };
    const trimmed = await proposePromptEdit({ plan, prompt: "Keep seconds 1 through 8 of the short", signal });
    const next = applyEditPlanChanges(plan, trimmed.changes);
    assert.deepEqual(next.cuts.map(({ start, end }) => ({ start, end })), [{ start: 12, end: 20 }, { start: 10, end: 16 }]);
    closePoint(focusPointAt(next.cuts[0]!.focusTrack, 12, fallback), focusPointAt(track(), 12, fallback));
    closePoint(focusPointAt(next.cuts[1]!.focusTrack, 16, fallback), focusPointAt(plan.cuts[1]!.focusTrack, 16, fallback));
    for (const operation of [{ op: "framing", focalPoint: fallback }, { op: "cut_focal_point", index: 0, focalPoint: fallback }]) {
      reply = { operations: [operation] };
      const result = await proposePromptEdit({ plan, prompt: "Keep this framing stationary", signal });
      const changed = applyEditPlanChanges(plan, result.changes);
      assert.equal(changed.cuts[0]!.focusTrack, undefined, "An identical static point still turns tracking off");
      if (operation.op === "cut_focal_point") assert.deepEqual(changed.cuts[1]!.focusTrack, plan.cuts[1]!.focusTrack);
      else assert.equal(changed.cuts[1]!.focusTrack, undefined);
    }
    reply = { patch: { brightness: 0.1 } };
    const color = await proposeManualPrompt({ settings: plan.settings, source, prompt: "Brighten a little", signal });
    assert.deepEqual(color.settings.segments, plan.settings.segments);
    reply = { patch: { focalPoint: fallback } };
    const fixed = await proposeManualPrompt({ settings: { ...plan.settings, focalPoint: fallback }, source, prompt: "Keep the source crop centered", signal });
    assert.ok(fixed.settings.segments!.every(cut => !cut.focusTrack));
    assert.ok(fixed.summary.length);
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = original;
  }
});
