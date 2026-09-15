import assert from "node:assert/strict";
import { test } from "node:test";
import { batchSchema } from "../server/schema.js";
import { createShortDraft, formatSourceClock, matchingShortSource, parseSourceClock, reconnectShortDraft, restoreShortDrafts, validateShortDraft, type ShortDraft } from "../shared/shorts.js";
import type { VideoSource } from "../shared/types.js";

const source: VideoSource = {
  id: "1dc97e51-b59d-446e-b4ae-1b1d9f7d32e1", name: "Long interview.mov", size: 40 * 1024 ** 3,
  duration: 12560.123, width: 1920, height: 1080, fps: 30, hasAudio: true,
  createdAt: "2026-09-15T12:00:00.000Z", url: "/api/sources/source/video", thumbnailUrl: "/api/sources/source/thumbnail", fingerprint: "a".repeat(64),
};
const draft = (): ShortDraft => createShortDraft(source, "draft-1", "cut-1", 3600, 1);

test("source clocks accept precise seconds, minute clocks and hour clocks without treating malformed values as zero", () => {
  for (const [input, expected] of [["0", 0], ["59.125", 59.125], ["90", 90], ["1:30.5", 90.5], ["125:03.001", 7503.001], ["03:29:20.123", 12560.123], [" 00:00:01.000 ", 1], ["24:00:00.000", 86400]] as const)
    assert.equal(parseSourceClock(input), expected, input);
  for (const input of ["", " ", "abc", "1e3", "-1", "+2", "1:60", "0:60:00", "1:01:60", "1:2:3:4", "1.5:10", "1:01.0001", ":12", "12:", "86401", "Infinity", "NaN"])
    assert.equal(parseSourceClock(input), null, input);
});

test("formatted source clocks round at millisecond boundaries and remain readable for multi-hour media", () => {
  assert.equal(formatSourceClock(59.9998), "00:01:00.000");
  assert.equal(formatSourceClock(3599.9998), "01:00:00.000");
  assert.equal(formatSourceClock(source.duration), "03:29:20.123");
  for (const value of [0, 0.001, 4.12, 12345.678, 86400]) assert.equal(parseSourceClock(formatSourceClock(value)), value);
  assert.equal(formatSourceClock(Number.NaN), "00:00:00.000");
});

test("new shorts select a bounded window at the current source clock and default to genuine Full HD portrait", () => {
  const value = draft();
  assert.deepEqual(value.cuts, [{ id: "cut-1", start: "01:00:00.000", end: "01:00:30.000" }]);
  assert.equal(value.sourceFingerprint, source.fingerprint);
  assert.equal(value.resolution, "1080");
  assert.equal(value.aspect, "9:16");
  assert.equal(value.qualityCleanup, false);
  const end = createShortDraft(source, "near-end", "cut", source.duration - 2);
  assert.equal(validateShortDraft(end, source).duration, 2);
  assert.ok(validateShortDraft(createShortDraft(source, "outside", "cut", source.duration + 20), source).settings);
});

test("ordered discontinuous sequences reach the renderer unchanged, including framing and local cleanup", () => {
  const value = draft();
  value.cuts = [{ id: "late", start: "02:00:00.125", end: "02:00:02.500", focalPoint: { x: 0.2, y: 0.7 } }, { id: "early", start: "00:01:10", end: "00:01:20.250" }];
  value.fit = "blur"; value.focalPoint = { x: 0.75, y: 0.4 }; value.normalizeAudio = true; value.qualityCleanup = true;
  const result = validateShortDraft(value, source);
  assert.deepEqual(result.errors, []);
  assert.equal(result.duration, 12.625);
  assert.deepEqual(result.settings!.segments, [{ start: 7200.125, end: 7202.5, focalPoint: { x: 0.2, y: 0.7 } }, { start: 70, end: 80.25 }]);
  assert.equal(result.settings!.fit, "blur");
  assert.equal(result.settings!.qualityCleanup, true);
  assert.equal(result.settings!.normalizeAudio, true);
  assert.equal(result.settings!.trimStart, 0);
  assert.equal(result.settings!.trimEnd, null);
  assert.equal(result.settings!.timeShift, 0);
  assert.ok(batchSchema.safeParse({ items: [{ sourceId: source.id, title: value.title, settings: result.settings }, { sourceId: source.id, title: "Another short", settings: result.settings }], variants: 1, randomize: false }).success, "Several named shorts can come from the same source");
});

test("invalid edits block rendering instead of restoring a previously valid timestamp", () => {
  const cases: [string, Partial<ShortDraft>][] = [
    ["empty title", { title: "  " }],
    ["control character title", { title: "My\nshort" }],
    ["malformed clock", { cuts: [{ id: "cut", start: "later", end: "00:00:30" }] }],
    ["backwards cut", { cuts: [{ id: "cut", start: "30", end: "20" }] }],
    ["empty cut", { cuts: [{ id: "cut", start: "30", end: "30" }] }],
    ["too short", { cuts: [{ id: "cut", start: "30", end: "30.040" }] }],
    ["outside source", { cuts: [{ id: "cut", start: "0", end: String(source.duration + 1) }] }],
    ["no cuts", { cuts: [] }],
    ["too many cuts", { cuts: Array.from({ length: 61 }, (_, index) => ({ id: String(index), start: "0", end: "1" })) }],
  ];
  for (const [name, patch] of cases) {
    const result = validateShortDraft({ ...draft(), ...patch }, source);
    assert.ok(result.errors.length, name); assert.equal(result.settings, null, name);
  }
  assert.equal(validateShortDraft(draft()).settings, null, "An unavailable source cannot render");
  assert.equal(validateShortDraft(draft(), { ...source, id: "different-source" }).settings, null);
});

test("saved drafts retain typed invalid timestamps and unavailable sources across reloads", () => {
  const value = draft(); value.cuts[0].start = "01:broken";
  const restored = restoreShortDrafts(JSON.parse(JSON.stringify({ version: 1, drafts: [value] })));
  assert.deepEqual(restored, [value]);
  assert.equal(restored[0].cuts[0].start, "01:broken");
  assert.equal(validateShortDraft(restored[0], source).settings, null);
  assert.equal(restoreShortDrafts({ version: 2, drafts: [value] }).length, 0);
  assert.equal(restoreShortDrafts({ version: 1, drafts: [value, value] }).length, 1);
  assert.equal(restoreShortDrafts({ version: 1, drafts: [{ ...value, cuts: [{ id: "x", start: 1, end: 2 }] }] }).length, 0);
});

test("restoration bounds malformed storage without introducing arbitrary export settings", () => {
  const restored = restoreShortDrafts({ version: 1, drafts: [{ ...draft(), aspect: "invalid", fit: "invalid", resolution: "4k", focalPoint: { x: 100, y: Number.NaN }, normalizeAudio: "true", qualityCleanup: 1, speed: 99, outputPath: "/tmp/anything" }] });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].aspect, "9:16"); assert.equal(restored[0].fit, "crop"); assert.equal(restored[0].resolution, "1080");
  assert.deepEqual(restored[0].focalPoint, { x: 0.5, y: 0.5 });
  assert.equal(restored[0].normalizeAudio, false); assert.equal(restored[0].qualityCleanup, false);
  assert.equal("outputPath" in restored[0], false); assert.equal("speed" in restored[0], false);
  assert.equal(restoreShortDrafts(null).length, 0);
  assert.equal(restoreShortDrafts({ version: 1, drafts: Array.from({ length: 120 }, (_, index) => ({ ...draft(), id: String(index) })) }).length, 100);
});

test("reimport matching requires a content fingerprint and reconnect preserves the complete edit", () => {
  const value = draft(); value.title = "A useful example"; value.cuts[0].end = "01:00:09.250"; value.fit = "contain";
  const sameName = { ...source, id: "same-name", fingerprint: "b".repeat(64) };
  assert.equal(matchingShortSource(value, [sameName]), undefined, "A filename is insufficient evidence of an identical video");
  const reimport = { ...source, id: "reimport", name: "Interview reimport.mp4" };
  assert.equal(matchingShortSource(value, [sameName, reimport]), reimport);
  const reconnected = reconnectShortDraft(value, reimport);
  assert.equal(reconnected.sourceId, "reimport"); assert.equal(reconnected.sourceName, reimport.name);
  assert.deepEqual(reconnected.cuts, value.cuts); assert.equal(reconnected.fit, value.fit); assert.equal(reconnected.title, value.title);
  assert.equal(validateShortDraft(reconnected, reimport).duration, 9.25);
  assert.equal(value.sourceId, source.id, "Reconnect leaves the prior draft object untouched");
  assert.equal(matchingShortSource({ ...value, sourceFingerprint: undefined }, [reimport]), undefined);
});
