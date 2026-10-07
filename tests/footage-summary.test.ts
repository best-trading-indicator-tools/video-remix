import assert from "node:assert/strict";
import { test } from "node:test";
import { footagePlacementLabel, type OwnFootagePlacement } from "../shared/own-footage.js";
import { visualSourceSummary } from "../shared/visual-sources.js";

const intro: OwnFootagePlacement = { id: "intro", assetId: "clip", mode: "insert", at: 0, start: 0, end: 3, audio: "clip", fit: "contain" };

test("source-only summaries include explicit clips even when automatic supporting shots are off", () => {
  assert.equal(visualSourceSummary({ visualSources: [] }), "Original footage only");
  assert.equal(visualSourceSummary({ visualSources: [], ownFootage: [intro] }), "Original + 1 added clip");
  assert.equal(visualSourceSummary({ visualSources: ["pexels"], ownFootage: [intro, { ...intro, id: "outro", appendToEnd: true }] }), "Original + Pexels + 2 added clips");
});

test("intro, outro, insert and cover labels describe actual placement semantics", () => {
  assert.equal(footagePlacementLabel(intro), "Intro · 3s before this video");
  assert.equal(footagePlacementLabel({ ...intro, appendToEnd: true }), "Outro · whole clip after this video");
  assert.equal(footagePlacementLabel({ ...intro, at: 12.5 }), "Insert at 12.5s · adds 3s");
  assert.equal(footagePlacementLabel({ ...intro, mode: "cover" }), "Cover at 0s · 3s");
});
