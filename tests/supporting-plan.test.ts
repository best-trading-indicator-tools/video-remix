import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSupportingVisuals,
  removeGraphicCalloutOverlaps,
} from "../server/supporting-plan.js";
import {
  DEFAULT_SETTINGS,
  type BrollAsset,
  type RenderJob,
  type Transcript,
} from "../shared/types.js";

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
