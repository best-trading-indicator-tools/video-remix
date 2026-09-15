import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSupportingVisuals,
  prepareSupportingVisuals,
  removeGraphicCalloutOverlaps,
} from "../server/supporting-plan.js";
import {
  DEFAULT_SETTINGS,
  type BrollAsset,
  type RenderJob,
  type Transcript,
} from "../shared/types.js";
import type { StoredBroll, StoredJob, StoredSource } from "../server/store.js";

const asset = (id: string, name: string, tags: string[] = []): BrollAsset => ({
  id,
  name,
  tags,
  duration: 3,
  size: 100,
  width: 320,
  height: 180,
  fps: 30,
  hasAudio: true,
  createdAt: "",
  thumbnailUrl: "",
  url: "",
});
const transcript: Transcript = {
  language: "en",
  duration: 24,
  segments: [
    { start: 0.1, end: 2, text: "Start with the mountain view.", words: [] },
    {
      start: 4,
      end: 6.5,
      text: "Watch the sunset over the sea.",
      words: [
        { start: 4, end: 4.3, word: "Watch" },
        { start: 4.3, end: 4.5, word: "the" },
        { start: 4.5, end: 5, word: "sunset" },
        { start: 5, end: 5.3, word: "over" },
        { start: 5.3, end: 5.6, word: "the" },
        { start: 5.6, end: 6.5, word: "sea." },
      ],
    },
    { start: 13, end: 16, text: "Follow the mountain trail.", words: [] },
  ],
};

test("a requested B-roll count replaces duration caps and keeps trying later matching moments", () => {
  const spoken: Transcript = { language: "en", duration: 30, segments: Array.from({ length: 6 }, (_, index) => ({
    start: 4 + index * 4, end: 6 + index * 4, text: `topic${index} visible activity`, words: [],
  })) };
  const assets = spoken.segments.map((_, index) => asset(`clip-${index}`, `topic${index}.mp4`));
  for (const count of [1, 4, 6, 10]) {
    const result = planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets, mode: "library", brollCount: count });
    assert.equal(result.length, Math.min(count, 6), `Try to fill ${count} distinct placements on the same 30-second edit`);
    assert.equal(new Set(result.map(shot => shot.assetId)).size, result.length);
    assert.ok(result.reduce((sum, shot) => sum + shot.end - shot.start, 0) <= 18 + 1e-8);
    assert.ok(result.every((shot, i) => shot.start >= 3.5 && shot.end <= 29.65 && (!i || shot.start >= result[i - 1]!.end + 0.6 - 1e-8)));
  }
  const later = planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets: assets.slice(2), mode: "library", brollCount: 4 });
  assert.equal(later.length, 4, "Unmatched early speech cannot stop the search for later placements");
  assert.equal(later[0]!.start, 12);
});

test("AI backup matches fill later slots while collisions and irrelevant clips remain excluded", () => {
  const spoken: Transcript = { language: "en", duration: 30, segments: [4, 5, 10, 16, 22, 26].map((start, i) => ({ start, end: start + 2, text: `Idea ${i}`, words: [] })) };
  const assets = spoken.segments.map((_, i) => asset(`clip-${i}`, `unrelated-name-${i}.mp4`));
  const result = planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets, mode: "library", brollCount: 4,
    aiMatches: assets.map((item, momentIndex) => ({ momentIndex, assetId: item.id, sourceStart: 0, reason: "Verified visual connection." })) });
  assert.deepEqual(result.map(shot => shot.start), [4, 10, 16, 22]);
  assert.deepEqual(planSupportingVisuals({ transcript: spoken, duration: 30, sourceName: "talk.mp4", assets, mode: "library", brollCount: 10, aiMatches: [] }), []);
});

test("a final motion rejection tries an alternative before reporting the achieved count", async () => {
  const assets: StoredBroll[] = ["a-still", "b-moving", "c-moving"].map(id => ({ ...asset(id, "sunset sea coast.mp4"),
    filePath: `/tmp/${id}.mp4`, thumbnailPath: "", stock: { providerId: `pixabay:${id}`, rendition: "https://cdn.pixabay.com/video/test.mp4", contentHash: id, retrievedAt: "", licenseUrl: "https://pixabay.com/service/license-summary/" } }));
  const source = { id: "source", name: "talk.mp4", width: 1280, height: 720, fps: 30, hasAudio: true, duration: 30 } as StoredSource;
  const job = { id: "test", auto: { aspect: "9:16", targetDuration: 30, narration: false, supportingVisuals: "library", brollCount: 2 }, settings: { ...DEFAULT_SETTINGS, aspect: "9:16" },
    summary: { title: "Talk", sourceDuration: 30, outputDuration: 30, changes: [], usedAI: false, narration: false, transcriptAvailable: true } } as StoredJob;
  const inspected: string[] = [];
  const result = await prepareSupportingVisuals({ source, job, assets, workDir: "/tmp", signal: new AbortController().signal, onPhase: () => {},
    transcript: { language: "en", duration: 30, segments: [4, 12, 20].map(start => ({ start, end: start + 2, text: "sunset sea coast", words: [] })) },
    inspect: async (clip) => { inspected.push(clip.filePath); return clip.filePath.includes("still") ? [] : [{ sourceStart: 0, duration: 3, motion: 1, cropRetention: 1 }]; } });
  assert.equal(result.length, 2);
  assert.deepEqual(job.supportingVisuals?.map(shot => shot.assetId), ["b-moving", "c-moving"]);
  assert.ok(inspected.some(file => file.includes("still")) && inspected.some(file => file.includes("c-moving")));
  assert.ok(job.notes?.some(note => note.includes("2 of 2 shots added")));
  assert.ok(!job.summary!.changes.some(change => change.includes("3 B-roll")));
});

test("supporting footage matches actual spoken moments using descriptive names or tags", () => {
  const result = planSupportingVisuals({
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "library",
    assets: [
      asset("unrelated", "cooking pasta.mp4"),
      asset("coast", "camera clip.mp4", ["sunset", "sea"]),
      asset("trail", "mountain trail.mp4"),
    ],
  });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => [item.assetId, item.start]),
    [
      ["coast", 4],
      ["trail", 13],
    ],
  );
  assert.ok(
    result.every((item) => item.end <= 24 && item.end - item.start <= 3),
  );
  assert.ok(!result.some((item) => item.assetId === "unrelated"));
});

test("supporting visuals stay optional and never invent speech for a silent clip", () => {
  const input = {
    sourceName: "sunset coast.mp4",
    duration: 15,
    assets: [asset("sea", "sunset.mp4")],
  };
  assert.deepEqual(planSupportingVisuals({ ...input, mode: "off" }), []);
  assert.deepEqual(planSupportingVisuals({ ...input, mode: "graphics" }), []);
  const matching = planSupportingVisuals({ ...input, mode: "library" });
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.assetId, "sea");
  assert.deepEqual(
    planSupportingVisuals({
      ...input,
      sourceName: "camera001.mp4",
      mode: "library",
    }),
    [],
  );
  assert.deepEqual(
    planSupportingVisuals({ ...input, duration: 3, mode: "library" }),
    [],
  );
});

test("graphic cards use existing spoken phrases and respect spacing and screen-time limits", () => {
  const result = planSupportingVisuals({
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "graphics",
    assets: [],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0]?.text, "Watch the sunset over the sea.");
  assert.equal(result[1]?.text, "Follow the mountain trail.");
  assert.ok(
    result.every((item) => item.kind === "graphic" && item.start >= 3.5),
  );
  assert.ok(
    result.reduce((total, item) => total + item.end - item.start, 0) <=
      24 * 0.3,
  );
});

test("AI matches use the inspected source window without requiring filename keywords", () => {
  const result = planSupportingVisuals({
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "library",
    assets: [{ ...asset("coast", "IMG_4821.mp4"), duration: 30 }],
    aiMatches: [
      {
        momentIndex: 0,
        assetId: "coast",
        sourceStart: 13.2,
        reason:
          "The sampled frames show a coastline at dusk, illustrating the spoken sunset.",
      },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]!.start, 4);
  assert.equal(result[0]!.sourceStart, 13.2);
  assert.equal(result[0]!.assetId, "coast");
  assert.match(result[0]!.reason!, /coastline/);
  assert.ok(result[0]!.end - result[0]!.start <= 3.6);
});

test("an AI rejection never falls back to keyword placement, and invalid references cannot create cutaways", () => {
  const input = {
    transcript,
    duration: 24,
    sourceName: "travel.mp4",
    mode: "library" as const,
    assets: [asset("coast", "sunset sea.mp4")],
  };
  assert.equal(planSupportingVisuals(input).length, 1);
  assert.deepEqual(planSupportingVisuals({ ...input, aiMatches: [] }), []);
  for (const match of [
    { momentIndex: 0, assetId: "not-selected", sourceStart: 0 },
    { momentIndex: 100, assetId: "coast", sourceStart: 0 },
    { momentIndex: 0, assetId: "coast", sourceStart: -1 },
    { momentIndex: 0, assetId: "coast", sourceStart: 2.9 },
    { momentIndex: 0, assetId: "coast", sourceStart: Number.NaN },
  ])
    assert.deepEqual(
      planSupportingVisuals({
        ...input,
        aiMatches: [{ ...match, reason: "Invalid suggestion" }],
      }),
      [],
    );
});

test("rendered cards suppress colliding callouts, preserve touching intervals and B-roll overlays, and update the edit summary", () => {
  const job: Pick<RenderJob, "settings" | "summary"> = {
    settings: {
      ...DEFAULT_SETTINGS,
      hookText: "Keep the opening hook",
      subtitleId: "captions-stay",
      callouts: [
        { text: "Ends at the card boundary", start: 2, end: 4 },
        { text: "Starts at the card boundary", start: 6, end: 8 },
        { text: "Overlaps the entrance", start: 3, end: 5 },
        { text: "Overlaps the exit", start: 5, end: 7 },
        { text: "Matches the card interval", start: 4, end: 6 },
        { text: "Useful over B-roll", start: 10, end: 12 },
      ],
    },
    summary: {
      title: "An edit",
      changes: ["Spoken hook", "Key-point overlays", "Speech captions"],
      sourceDuration: 24,
      outputDuration: 24,
      transcriptAvailable: true,
      usedAI: false,
      narration: false,
    },
  };
  removeGraphicCalloutOverlaps(job, [
    { kind: "graphic", start: 4, end: 6 },
    { kind: "broll", start: 10, end: 13 },
  ]);
  assert.deepEqual(
    job.settings.callouts?.map((callout) => callout.text),
    [
      "Ends at the card boundary",
      "Starts at the card boundary",
      "Useful over B-roll",
    ],
  );
  assert.ok(job.summary!.changes.includes("Key-point overlays"));
  assert.equal(job.settings.hookText, "Keep the opening hook");
  assert.equal(job.settings.subtitleId, "captions-stay");
  removeGraphicCalloutOverlaps(job, [{ kind: "graphic", start: 1, end: 14 }]);
  assert.deepEqual(job.settings.callouts, []);
  assert.deepEqual(job.summary!.changes, ["Spoken hook", "Speech captions"]);
});
