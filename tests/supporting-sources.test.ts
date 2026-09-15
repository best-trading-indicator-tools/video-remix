import assert from "node:assert/strict";
import { test } from "node:test";
import { planSupportingVisuals, prepareSupportingVisuals } from "../server/supporting-plan.js";
import { DEFAULT_SETTINGS, type BrollAsset, type Transcript, type VisualSource } from "../shared/types.js";
import type { StoredBroll, StoredJob, StoredSource } from "../server/store.js";

const sources: VisualSource[] = ["pixabay", "hyperframes", "remotion"];
const speech: Transcript = { language: "en", duration: 60, segments: Array.from({ length: 11 }, (_, index) => ({
  start: 4 + index * 5, end: 6 + index * 5, text: "Watch the sunset over the sea.", words: [],
})) };
const asset = (id: string, stock = true): BrollAsset => ({
  id, name: "sunset sea coast.mp4", tags: ["sunset", "sea"], duration: 6, size: 100,
  width: 320, height: 180, fps: 30, hasAudio: false, createdAt: "", thumbnailUrl: "", url: "",
  ...(stock ? { stock: { providerId: `pixabay:${id}`, rendition: "https://cdn.pixabay.com/video/fixture.mp4",
    contentHash: id, retrievedAt: "", licenseUrl: "https://pixabay.com/service/license-summary/" } } : {}),
});
const assets = Array.from({ length: 12 }, (_, index) => asset(`clip-${String(index).padStart(2, "0")}`));
const base = { transcript: speech, duration: 60, sourceName: "talk.mp4", assets, mode: "off" as const };
const storedAssets: StoredBroll[] = assets.map(asset => ({ ...asset, filePath: `/tmp/${asset.id}.mp4`, thumbnailPath: "" }));
const source = { id: "source", name: "talk.mp4", width: 1280, height: 720, fps: 30, hasAudio: true, duration: 60 } as StoredSource;
const jobFor = (visualSources: VisualSource[], brollCount = 6): StoredJob => ({ id: "fixture",
  auto: { aspect: "9:16", targetDuration: 60, narration: false, visualSources, brollCount, brollMatching: "tags" },
  settings: { ...DEFAULT_SETTINGS, aspect: "9:16", resolution: "1080" }, summary: { title: "Talk", sourceDuration: 60, outputDuration: 60,
    changes: [], usedAI: false, narration: false, transcriptAvailable: true },
} as StoredJob);
const prepare = (job: StoredJob, extra: Partial<Parameters<typeof prepareSupportingVisuals>[0]> = {}) => prepareSupportingVisuals({
  source, job, transcript: speech, assets: [], workDir: "/tmp", signal: new AbortController().signal, onPhase: () => {},
  findStock: async () => { assert.fail("An unselected stock source must not make requests"); },
  matchAI: async () => { assert.fail("Tag matching and graphics must not invoke AI"); },
  available: async () => true,
  render: async () => { assert.fail("An unselected renderer must not run"); },
  inspect: async () => [{ sourceStart: 0, duration: 3, motion: 1, cropRetention: 1 }],
  ...extra,
});

test("refreshing the remaining slots retains the dense timing of the original total target", () => {
  const transcript: Transcript = { language: "en", duration: 30,
    segments: Array.from({ length: 10 }, (_, i) => ({ start: 4 + i * 2.5, end: 5.8 + i * 2.5,
      text: "Watch the sunset over the sea.", words: [] })) };
  const occupied = transcript.segments.filter((_, i) => i % 2 === 0).map(({ start, end }) => ({ start, end }));
  const result = planSupportingVisuals({ ...base, transcript, duration: 30, visualSources: ["pixabay"], brollCount: 5, occupied });
  assert.equal(result.length, 5, "All five remaining slots fit alongside the five kept cards");
  assert.deepEqual(result.map(shot => shot.start), [6.5, 11.5, 16.5, 21.5, 26.5]);
  assert.ok(result.every(shot => shot.end - shot.start <= 1.8 + 1e-9));
});

test("all seven stock/renderer combinations share the requested total and rotate ties between selected sources", () => {
  for (let mask = 1; mask < 8; mask++) {
    const visualSources = sources.filter((_source, index) => mask & (1 << index));
    const result = planSupportingVisuals({ ...base, visualSources: [...visualSources].reverse(), brollCount: 6 });
    assert.equal(result.length, 6, visualSources.join(" + "));
    assert.deepEqual(result.map(shot => shot.visualSource), Array.from({ length: 6 }, (_, index) => visualSources[index % visualSources.length]));
    const stockShots = result.filter(shot => shot.kind === "broll");
    assert.equal(new Set(stockShots.map(shot => shot.assetId)).size, stockShots.length);
    assert.ok(result.every((shot, index) => shot.start >= 3.5 && shot.end <= 59.65 &&
      (!index || shot.start >= result[index - 1]!.end + 0.6 - 1e-8)));
    assert.ok(result.reduce((total, shot) => total + shot.end - shot.start, 0) <= 60 * 0.6);
    assert.ok(result.filter(shot => shot.kind === "graphic").every(shot => speech.segments.some(segment => segment.text === shot.text)));
  }
});

test("the count is a shared target even below the source count or above the old three-card cap", () => {
  for (const brollCount of [1, 2, 4, 10]) {
    const result = planSupportingVisuals({ ...base, visualSources: sources, brollCount });
    assert.equal(result.length, brollCount);
    assert.ok(result.every(shot => sources.includes(shot.visualSource!)));
  }
  assert.equal(planSupportingVisuals({ ...base, assets: [], visualSources: ["remotion"], brollCount: 10 }).length, 10);
  assert.equal(planSupportingVisuals({ ...base, assets: [], visualSources: ["hyperframes"], brollCount: 10 }).length, 10);
});

test("an unavailable match gives selected renderers more slots without inventing unselected sources", () => {
  const result = planSupportingVisuals({ ...base, assets: [], visualSources: sources, brollCount: 6 });
  assert.deepEqual(result.map(shot => shot.visualSource), ["hyperframes", "remotion", "hyperframes", "remotion", "hyperframes", "remotion"]);
  const library = [asset("library-match", false)];
  assert.deepEqual(planSupportingVisuals({ ...base, assets: library, visualSources: ["pixabay"], brollCount: 4 }), []);
  assert.deepEqual(planSupportingVisuals({ ...base, visualSources: ["library"], brollCount: 4 }), []);
  assert.deepEqual(planSupportingVisuals({ ...base, visualSources: ["pixabay"], aiMatches: [], brollCount: 4 }), []);
  const rejected = planSupportingVisuals({ ...base, visualSources: ["pixabay", "remotion"], aiMatches: [], brollCount: 4 });
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every(shot => shot.kind === "graphic" && shot.visualSource === "remotion"));
});

test("an explicitly selected library keeps downloaded stock origin separate from source selection", () => {
  const selected = assets[0]!;
  const result = planSupportingVisuals({ ...base, assets: [selected], visualSources: ["library"],
    assetSources: { [selected.id]: "library" }, brollCount: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.visualSource, "library");
  assert.equal(result[0]!.assetId, selected.id);
});

test("silent clips cannot create invented motion-card text and an explicit empty selection stays off", () => {
  const silent = { duration: 30, sourceName: "sunset sea coast.mp4", assets };
  assert.deepEqual(planSupportingVisuals({ ...silent, visualSources: ["hyperframes", "remotion"] }), []);
  const mixed = planSupportingVisuals({ ...silent, visualSources: sources });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]!.kind, "broll");
  assert.equal(mixed[0]!.visualSource, "pixabay");
  assert.deepEqual(planSupportingVisuals({ ...base, mode: "stock", visualSources: [] }), []);
  assert.deepEqual(planSupportingVisuals({ ...base, mode: "both", visualSources: [] }), []);
});

test("reserved saved shots retain their time and coverage when new supporting visuals are planned", () => {
  const occupied = [{ start: 4, end: 6.4 }, { start: 19, end: 21.4 }];
  const result = planSupportingVisuals({ ...base, visualSources: sources, brollCount: 4, occupied });
  assert.equal(result.length, 4);
  assert.ok(result.every(shot => occupied.every(saved => shot.start >= saved.end + 1.2 - 1e-8 || shot.end + 1.2 <= saved.start + 1e-8)));
  assert.ok([...result, ...occupied].reduce((total, shot) => total + shot.end - shot.start, 0) <= 60 * 0.6);
  assert.deepEqual(occupied, [{ start: 4, end: 6.4 }, { start: 19, end: 21.4 }]);
});

test("preparation dispatches every mix to exactly its selected stock provider and renderers", async () => {
  for (let mask = 1; mask < 8; mask++) {
    const visualSources = sources.filter((_source, index) => mask & (1 << index));
    const job = jobFor(visualSources);
    let stockCalls = 0;
    const availability: string[] = [], rendered: string[] = [];
    const result = await prepare(job, {
      findStock: async options => {
        assert.ok(visualSources.includes("pixabay")); assert.equal(options.targetCount, 6); stockCalls++;
        return { assets: storedAssets, notes: [] };
      },
      available: async renderer => { availability.push(renderer); return true; },
      render: async (renderer, options) => {
        assert.ok(visualSources.includes(renderer)); rendered.push(renderer);
        assert.equal(options.width, 1080); assert.equal(options.height, 1920);
        assert.ok(options.output.includes(`supporting-${renderer}-`));
        assert.ok(speech.segments.some(segment => segment.text === options.text));
      },
    });
    assert.equal(stockCalls, visualSources.includes("pixabay") ? 1 : 0);
    assert.deepEqual(availability, visualSources.filter(source => source !== "pixabay"));
    assert.deepEqual(rendered, result.filter(shot => shot.kind === "graphic").map(shot => shot.visualSource));
    assert.equal(result.length, 6);
    assert.deepEqual(job.supportingVisuals?.map(shot => shot.visualSource), result.map(shot => shot.visualSource));
    assert.ok(job.notes?.some(note => note.includes("6 of 6 shots added")));
  }
});

test("a frozen stock candidate is replaced while the requested mixed-source total remains bounded", async () => {
  const job = jobFor(["pixabay", "remotion"], 4);
  const inspected: string[] = [];
  const result = await prepare(job, {
    findStock: async () => ({ assets: storedAssets.slice(0, 4), notes: [] }),
    render: async renderer => { assert.equal(renderer, "remotion"); },
    inspect: async asset => {
      inspected.push(asset.id);
      return asset.id === "clip-00" ? [] : [{ sourceStart: 0, duration: 3, motion: 1, cropRetention: 1 }];
    },
  });
  assert.equal(result.length, 4);
  assert.deepEqual(result.map(shot => shot.visualSource), ["pixabay", "remotion", "pixabay", "remotion"]);
  assert.ok(inspected.includes("clip-00") && inspected.includes("clip-02"));
  assert.ok(job.supportingVisuals!.every(shot => shot.assetId !== "clip-00"));
  assert.ok(job.notes?.some(note => note.includes("4 of 4 shots added")));
});

test("unavailable renderers leave other selected sources usable and rendering failures keep original footage", async () => {
  const job = jobFor(["hyperframes", "remotion"]);
  const rendered: string[] = [];
  const result = await prepare(job, { available: async renderer => renderer === "remotion",
    render: async renderer => { rendered.push(renderer); },
  });
  assert.deepEqual(rendered, Array(6).fill("remotion"));
  assert.equal(result.length, 6);
  assert.ok(job.notes?.some(note => note.includes("HyperFrames is unavailable")));
  const partial = jobFor(["hyperframes", "remotion"]);
  const remaining = await prepare(partial, { render: async renderer => {
    if (renderer === "remotion") throw new Error("private renderer filesystem diagnostic");
  } });
  assert.equal(remaining.length, 3);
  assert.ok(remaining.every(shot => shot.visualSource === "hyperframes"));
  assert.ok(partial.notes?.some(note => /Remotion.*could not be rendered/u.test(note)));
  assert.ok(!JSON.stringify(partial.notes).includes("private renderer"));
});

test("empty selections do no work and cancellation during an active renderer stops the mixed edit", async () => {
  const off = jobFor([]); off.auto!.supportingVisuals = "stock";
  assert.deepEqual(await prepare(off, { available: async () => { assert.fail("Off does not probe renderers"); } }), []);
  const controller = new AbortController(), job = jobFor(["hyperframes", "remotion"]);
  let renders = 0;
  await assert.rejects(prepare(job, { signal: controller.signal, render: async (_renderer, options) => {
    renders++; controller.abort(); options.signal.throwIfAborted();
  } }), { name: "AbortError" });
  assert.equal(renders, 1, "Cancellation must not continue to another selected renderer");
});

test("stock-refresh overrides do not temporarily replace the saved mix or total target", async () => {
  const job = jobFor(["pixabay", "remotion"], 6), original = job.auto;
  const before = structuredClone(original);
  const result = await prepare(job, {
    options: { ...job.auto!, visualSources: ["pixabay"], brollCount: 2 },
    findStock: async options => {
      assert.equal(options.targetCount, 2);
      assert.equal(job.auto, original, "Concurrent readers must still see the saved preferences during the search");
      assert.deepEqual(job.auto, before);
      return { assets: storedAssets, notes: [] };
    },
    available: async () => { assert.fail("Refreshing stock must not invoke saved animation renderers"); },
  });
  assert.equal(result.length, 2);
  assert.ok(result.every(shot => shot.visualSource === "pixabay"));
  assert.equal(job.auto, original);
  assert.deepEqual(job.auto, before);
});
