import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoOptions, VisualSource } from "../shared/types.js";
import { getVisualSources, hasGraphicVisuals, hasLibraryVisuals, hasStockVisuals } from "../shared/visual-sources.js";
import { autoBatchSchema, autoOptionsSchema } from "../server/schema.js";

const choices: VisualSource[] = ["pixabay", "pexels", "hyperframes", "remotion", "library"];

test("every independent source and source combination is accepted and resolved in canonical order", () => {
  for (let mask = 0; mask < 32; mask++) {
    const expected = choices.filter((_source, index) => mask & (1 << index));
    const selected = [...expected].reverse();
    const parsed = autoOptionsSchema.parse({ visualSources: selected, supportingVisuals: "both" });
    assert.deepEqual(getVisualSources(parsed), expected);
    assert.equal(hasStockVisuals(parsed), (expected.includes("pixabay") || expected.includes("pexels")));
    assert.equal(hasLibraryVisuals(parsed), expected.includes("library"));
    assert.equal(hasGraphicVisuals(parsed), expected.includes("hyperframes") || expected.includes("remotion"));
    assert.deepEqual(parsed.visualSources, selected, "Resolving source order must not mutate the saved preference");
  }
});

test("legacy modes keep their existing source behavior when explicit selections are absent", () => {
  const cases: [AutoOptions["supportingVisuals"], VisualSource[]][] = [
    [undefined, []], ["off", []], ["stock", ["pixabay"]], ["graphics", ["hyperframes"]],
    ["library", ["library"]], ["both", ["hyperframes", "library"]],
  ];
  for (const [supportingVisuals, expected] of cases) {
    const options = autoOptionsSchema.parse({ supportingVisuals });
    assert.equal(options.visualSources, undefined);
    assert.deepEqual(getVisualSources(options), expected);
    assert.equal(hasStockVisuals(options), (expected.includes("pixabay") || expected.includes("pexels")));
    assert.equal(hasLibraryVisuals(options), expected.includes("library"));
    assert.equal(hasGraphicVisuals(options), expected.includes("hyperframes"));
  }
  assert.deepEqual(getVisualSources(), []);
});

test("an explicitly empty list disables visuals despite stale legacy modes and survives serialization", () => {
  for (const supportingVisuals of ["stock", "graphics", "library", "both"] as const) {
    const options = JSON.parse(JSON.stringify(autoOptionsSchema.parse({ supportingVisuals, visualSources: [] })));
    assert.deepEqual(options.visualSources, []);
    assert.deepEqual(getVisualSources(options), []);
    assert.equal(hasStockVisuals(options), false);
    assert.equal(hasLibraryVisuals(options), false);
    assert.equal(hasGraphicVisuals(options), false);
  }
  assert.deepEqual(getVisualSources({ supportingVisuals: "off", visualSources: ["remotion"] }), ["remotion"]);
});

test("duplicate and unsupported source selections are rejected at the API boundary", () => {
  for (const visualSources of [
    ["pixabay", "pixabay"], ["remotion", "remotion"], ["unknown"], ["graphics"], ["stock"],
    ["Pixabay"], ["off"], ["pixabay", "pexels", "hyperframes", "remotion", "library", "pixabay"],
    [null], [1], "pixabay", null, {},
  ]) assert.equal(autoOptionsSchema.safeParse({ visualSources }).success, false, JSON.stringify(visualSources));
});

test("per-source and legacy batch payloads preserve explicit selections without inventing fallback sources", () => {
  const first = "42bfcdab-f4a4-4e4b-85d5-8ac2309a25de", second = "c58ab8f1-f0c0-4a4d-88f7-3cc6407b44d2";
  const batch = autoBatchSchema.parse({ items: [
    { sourceId: first, options: { visualSources: ["remotion", "pixabay"] } },
    { sourceId: second, options: { visualSources: [], supportingVisuals: "stock" } },
  ] });
  assert.deepEqual(batch.items.map(item => getVisualSources(item.options)), [["pixabay", "remotion"], []]);
  const legacy = autoBatchSchema.parse({ sourceIds: [first, second], options: { visualSources: ["library", "hyperframes"] } });
  assert.deepEqual(legacy.items.map(item => getVisualSources(item.options)), [["hyperframes", "library"], ["hyperframes", "library"]]);
});

test("resolved lists cannot mutate stored preferences or later resolutions", () => {
  const options = { visualSources: ["library", "pixabay"] as VisualSource[] };
  const resolved = getVisualSources(options);
  resolved.splice(0, resolved.length, "remotion");
  assert.deepEqual(options.visualSources, ["library", "pixabay"]);
  assert.deepEqual(getVisualSources(options), ["pixabay", "library"]);
});
