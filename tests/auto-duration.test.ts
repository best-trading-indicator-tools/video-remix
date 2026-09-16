import assert from "node:assert/strict";
import { test } from "node:test";
import { autoBatchSchema, autoOptionsSchema } from "../server/schema.js";
import { buildCandidates, cutsDuration, sceneCuts, selectSpeechCuts } from "../server/auto-plan.js";
import { isAutoTargetDuration, type Transcript } from "../shared/types.js";

test("custom Auto lengths survive both batch payloads and use the same validation as saved preferences", () => {
  const sourceId = "3f4509be-8c84-4cec-aa7c-0af38bd794d9";
  for (const targetDuration of [1, 7, 30, 45, 60, 75, 120, 3600, 86401, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isAutoTargetDuration(targetDuration), true);
    const options = { targetDuration };
    assert.equal(autoOptionsSchema.parse(options).targetDuration, targetDuration);
    const legacy = autoBatchSchema.parse({ sourceIds: [sourceId], options });
    const perVideo = autoBatchSchema.parse({ items: [{ sourceId, options }] });
    assert.equal(legacy.items[0].options.targetDuration, targetDuration);
    assert.equal(perVideo.items[0].options.targetDuration, targetDuration);
  }
  for (const targetDuration of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "75", null]) {
    assert.equal(isAutoTargetDuration(targetDuration), false);
    assert.equal(autoOptionsSchema.safeParse({ targetDuration }).success, false);
  }
  assert.equal(isAutoTargetDuration(undefined), false);
  assert.equal(autoOptionsSchema.parse({}).targetDuration, 45);
});

test("custom lengths bound scene and spoken cuts and never extend a shorter original", () => {
  const transcript: Transcript = { language: "en", duration: 180, segments: [{ start: 0.2, end: 0.7, text: "Go.",
    words: [{ start: 0.2, end: 0.7, word: "Go." }] }, { start: 2, end: 76, text: "A complete longer explanation.", words: [] }] };
  for (const duration of [1, 7, 75, 120, 3600]) {
    const cuts = sceneCuts([2, 14, 50, 100], 180, duration, 0);
    assert.ok(cuts.length);
    assert.ok(Math.abs(cutsDuration(cuts) - Math.min(duration, 180)) < 0.001);
    const candidates = buildCandidates(transcript, 180, duration, 0);
    assert.ok(candidates.length);
    for (const candidate of candidates) assert.ok(cutsDuration(selectSpeechCuts(transcript, candidate)) <= duration);
  }
  assert.ok(buildCandidates(transcript, 180, 75, 0).some(candidate => candidate.end - candidate.start > 60),
    "Longer requested lengths must allow spoken ideas beyond the old 60-second ceiling");
});
