import assert from "node:assert/strict";
import { test } from "node:test";
import { footageForSource, mergeSourceSettings, type OwnFootagePlacement } from "../shared/own-footage.js";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS } from "../shared/types.js";
import { autoBatchSchema, batchSchema } from "../server/schema.js";

const samsung = "50267a98-cab5-4746-8dfb-b5cb5f9bec4b";
const other = "c609718d-8e44-4e54-8614-9c01df1477b5";
const intro: OwnFootagePlacement = { id: "4a4bb603-b1fc-4f43-ab0c-6adcbbac2b5f", assetId: "dc998327-ac9c-4c38-a21a-aa8a22d7799e", mode: "insert", at: 0, start: 0, end: 3, audio: "clip", fit: "contain" };
const watermarkRemoval = { enabled: true, mode: "fixed" as const, masks: [{ id: "57da0175-c90f-494d-a8d7-857b7d8e231e", start: 0, end: 50.2,
  strokes: [{ kind: "rect" as const, size: 0.04, points: [{ x: 0.2457, y: 0.11553 }, { x: 0.7431, y: 0.21541 }] }] }] };

test("legacy workspace inserts are cleared while Samsung's watermark and other settings survive", () => {
  const saved = { ...DEFAULT_AUTO_OPTIONS, ownFootage: [intro], watermarkRemoval };
  const restored = footageForSource(saved, samsung);
  assert.deepEqual(restored.ownFootage, []);
  assert.deepEqual(restored.watermarkRemoval, watermarkRemoval);
  assert.equal(restored.aspect, saved.aspect);
  assert.deepEqual(saved.ownFootage, [intro], "Migration does not mutate saved export settings");
});

test("explicit placements survive reload only for their source and never become import defaults", () => {
  const settings = { ownFootage: [intro], ownFootageSourceId: samsung };
  assert.deepEqual(footageForSource(settings, samsung).ownFootage, [intro]);
  assert.deepEqual(footageForSource(settings, other).ownFootage, []);
  assert.deepEqual(footageForSource(settings).ownFootage, []);
});

test("general settings copies preserve each target's clips instead of copying the current video's intro", () => {
  const target = { ...DEFAULT_AUTO_OPTIONS, ownFootage: [{ ...intro, at: 12 }], ownFootageSourceId: other };
  const patch = { aspect: "1:1" as const, ownFootage: [intro], ownFootageSourceId: samsung };
  const merged = mergeSourceSettings(target, patch, other);
  assert.equal(merged.aspect, "1:1");
  assert.equal(merged.ownFootageSourceId, other);
  assert.deepEqual(merged.ownFootage, target.ownFootage);
  assert.equal(mergeSourceSettings(DEFAULT_AUTO_OPTIONS, patch, other).ownFootage, undefined);
});

test("Auto API excludes inherited inserts from old tabs but accepts deliberately source-bound clips", () => {
  for (const ownFootageSourceId of [undefined, other, samsung]) {
    const request = { items: [{ sourceId: samsung, options: { ...DEFAULT_AUTO_OPTIONS, durationMode: "full", ownFootage: [intro], ownFootageSourceId, watermarkRemoval } }] };
    const item = autoBatchSchema.parse(request).items[0]!;
    assert.equal(item.sourceId, samsung);
    assert.equal(item.variants, 1);
    assert.deepEqual(item.options.ownFootage, ownFootageSourceId === samsung ? [intro] : []);
    assert.deepEqual(item.options.watermarkRemoval, watermarkRemoval);
  }
});

test("legacy multi-source Auto API cannot spread one video's explicit intro to the other source", () => {
  const result = autoBatchSchema.parse({ sourceIds: [samsung, other], options: { ...DEFAULT_AUTO_OPTIONS, ownFootage: [intro], ownFootageSourceId: samsung } });
  assert.deepEqual(result.items[0]!.options.ownFootage, [intro]);
  assert.deepEqual(result.items[1]!.options.ownFootage, []);
});

test("Manual API applies the same source check and keeps watermark settings", () => {
  for (const ownFootageSourceId of [undefined, other, samsung]) {
    const item = batchSchema.parse({ items: [{ sourceId: samsung, settings: { ...DEFAULT_SETTINGS, ownFootage: [intro], ownFootageSourceId, watermarkRemoval } }] }).items[0]!;
    assert.deepEqual(item.settings.ownFootage, ownFootageSourceId === samsung ? [intro] : []);
    assert.deepEqual(item.settings.watermarkRemoval, watermarkRemoval);
  }
});
