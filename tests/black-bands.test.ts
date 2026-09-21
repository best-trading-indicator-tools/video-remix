import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BLACK_BANDS, applyBandFinish, blackBandGeometry, bandTextLayout } from "../shared/black-bands.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { settingsSchema, autoOptionsSchema } from "../server/schema.js";
import { captureFinishingPreset } from "../shared/finishing-presets.js";
import { textLayoutIssues } from "../shared/framing.js";
import { editPlanChangesSchema } from "../server/edit-plan.js";

const bands = { ...DEFAULT_BLACK_BANDS, enabled: true, topText: "My headline", bottomText: "My footer" };

test("Auto, Manual and saved edit revisions accept bands and reject malformed settings", () => {
  assert.deepEqual(settingsSchema.parse({ ...DEFAULT_SETTINGS, blackBands: bands }).blackBands, bands);
  assert.deepEqual(autoOptionsSchema.parse({ blackBands: bands }).blackBands, bands);
  assert.deepEqual(editPlanChangesSchema.parse({ revision: 0, framing: { blackBands: bands } }).framing?.blackBands, bands);
  for (const invalid of [
    { topPercent: 0 }, { bottomPercent: 41 }, { topPercent: 40, bottomPercent: 40 },
    { topPercent: Infinity }, { fontPercent: NaN }, { fit: "blur" },
    { topText: "x".repeat(201) }, { bottomText: "hello\0world" }, { enabled: "yes" },
  ]) {
    assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, blackBands: { ...bands, ...invalid } }).success, false);
    assert.equal(autoOptionsSchema.safeParse({ blackBands: { ...bands, ...invalid } }).success, false);
  }
});

test("band finishing presets preserve each video's words", () => {
  for (const mode of ["auto", "manual"] as const) {
    const preset = captureFinishingPreset(mode, "Headline", { ...DEFAULT_SETTINGS, blackBands: bands }, "bands");
    if (preset.mode === "shorts") throw new Error("Unexpected preset");
    assert.equal("topText" in preset.settings.blackBands!, false);
    const applied = applyBandFinish({ ...bands, topText: "A different video", bottomText: "Different footer" }, preset.settings.blackBands);
    assert.equal(applied?.topText, "A different video");
    assert.equal(applied?.bottomText, "Different footer");
    assert.equal(applied?.enabled, true);
    assert.equal(applyBandFinish(undefined, preset.settings.blackBands)?.topText, "");
  }
});

test("geometry leaves an even video window and long text fits inside both bands", () => {
  const box = blackBandGeometry(1080, 1920, bands);
  assert.deepEqual(box, { width: 1080, height: 1152, top: 480, bottom: 288, canvasHeight: 1920 });
  for (const [width, height] of [[1080, 1920], [1920, 1080]]) {
    const layout = bandTextLayout("W".repeat(200), width!, height!, height! * 0.1, 10);
    const lines = layout.text.split("\n");
    assert.ok(lines.length * layout.fontSize * 1.25 <= height! * 0.08);
    assert.ok(lines.every(line => [...line].length * layout.fontSize <= width! * 0.9));
  }
});

test("placement guidance flags bottom text colliding with speech captions", () => {
  const settings = { ...DEFAULT_SETTINGS, aspect: "9:16" as const, blackBands: bands };
  assert.ok(textLayoutIssues({ settings, captions: [{ id: "one", start: 0, end: 1, text: "Speech caption" }] })
    .some(issue => issue.code === "text-collision" && issue.message.includes("bottom band text")));
  assert.equal(textLayoutIssues({ settings: { ...settings, blackBands: { ...bands, bottomText: "" } }, captions: [] }).length, 0);
});
