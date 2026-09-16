import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  applyPacing,
  NATURAL_PACING,
  pacingOptionsSchema,
  pacingReviewSchema,
  suggestPacing,
} from "../shared/pacing.js";
import { DEFAULT_SETTINGS, type Transcript } from "../shared/types.js";
import { runLocal } from "../server/auto-process.js";
import { renderVideo, probeMedia } from "../server/engine.js";
import { installPacingRoutes } from "../server/pacing-routes.js";
import { state, type StoredSource } from "../server/store.js";
import { createShortDraft, restoreShortDrafts } from "../shared/shorts.js";

const words = [
  { start: 0.1, end: 0.5, word: "I", probability: 0.99 },
  { start: 0.6, end: 1, word: "would", probability: 0.99 },
  { start: 2.5, end: 2.8, word: "not", probability: 0.99 },
  { start: 3, end: 3.2, word: "um", probability: 0.95 },
  { start: 3.4, end: 3.8, word: "change", probability: 0.99 },
  { start: 3.9, end: 4.5, word: "that.", probability: 0.99 },
];
const transcript: Transcript = {
  language: "en",
  duration: 5,
  segments: [
    { start: 0.1, end: 4.5, text: "I would not um change that.", words },
  ],
};
const cuts = [{ start: 0, end: 5 }];

test("natural pacing preserves every spoken word, the opening and ending, and breathing room", () => {
  const result = suggestPacing(transcript, cuts, NATURAL_PACING);
  assert.equal(result.removals.length, 1);
  const removal = result.removals[0];
  assert.equal(removal.kind, "pause");
  assert.ok(Math.abs(2.5 - 1 - (removal.end - removal.start) - 0.35) < 1e-6);
  const output = applyPacing(cuts, result.removals);
  assert.equal(output[0].start, 0);
  assert.equal(output.at(-1)!.end, 5);
  for (const word of words)
    assert.ok(
      output.some((cut) => cut.start <= word.start && cut.end >= word.end),
      `Dropped ${word.word}`,
    );
  assert.deepEqual(
    applyPacing(cuts, result.removals, [removal.id]),
    cuts,
    "Each suggested removal can be restored individually",
  );
  assert.deepEqual(
    suggestPacing(transcript, cuts, { ...NATURAL_PACING, mode: "off" })
      .removals,
    [],
  );
  assert.ok(
    suggestPacing(transcript, cuts, { ...NATURAL_PACING, mode: "tight" })
      .removals[0].end -
      removal.end >
      0,
  );
});

test("only isolated high-confidence filler sounds are optional; meaning-bearing words and uncertain timings remain", () => {
  const options = { ...NATURAL_PACING, removeFillers: true };
  const result = suggestPacing(transcript, cuts, options);
  assert.equal(
    result.removals.filter((item) => item.kind === "filler").length,
    1,
  );
  const output = applyPacing(cuts, result.removals);
  assert.ok(
    output.some((cut) => cut.start <= 2.5 && cut.end >= 2.8),
    "The negation must remain",
  );
  for (const patch of [
    { word: "like" },
    { word: "so" },
    { probability: 0.4 },
    { probability: undefined },
    { start: 2.82 },
  ]) {
    const changed = structuredClone(transcript);
    Object.assign(changed.segments[0].words[3], patch);
    assert.equal(
      suggestPacing(changed, cuts, options).removals.filter(
        (item) => item.kind === "filler",
      ).length,
      0,
    );
  }
  const coarse = {
    ...transcript,
    segments: [{ ...transcript.segments[0], words: [] }],
  };
  assert.equal(suggestPacing(coarse, cuts, options).removals.length, 0);
  assert.match(suggestPacing(coarse, cuts, options).notes[0], /preserved/);
});

test("pacing follows repeated/reordered sequence occurrences, clips camera tracks and enforces the cut budget", () => {
  const repeated = [
    { start: 2, end: 5 },
    {
      start: 0,
      end: 5,
      focusTrack: [
        { time: 0, x: 0.2, y: 0.5 },
        { time: 5, x: 0.8, y: 0.5 },
      ],
    },
  ];
  const result = suggestPacing(transcript, repeated, NATURAL_PACING);
  assert.equal(result.removals[0].cutIndex, 1);
  const output = applyPacing(repeated, result.removals);
  assert.deepEqual(output[0], repeated[0]);
  assert.ok(
    output
      .slice(1)
      .every((cut) =>
        cut.focusTrack!.every(
          (point) => point.time >= cut.start && point.time <= cut.end,
        ),
      ),
  );
  const many = Array.from({ length: 60 }, () => ({ start: 0, end: 5 }));
  assert.equal(
    suggestPacing(transcript, many, NATURAL_PACING).removals.length,
    0,
  );
  assert.equal(
    pacingOptionsSchema.safeParse({
      ...NATURAL_PACING,
      mode: "custom",
      minimumPause: 0.4,
      keepPause: 0.5,
    }).success,
    false,
  );
  assert.equal(
    pacingReviewSchema.safeParse({
      baseCuts: [{ id: "one", start: "0", end: "5" }],
      options: NATURAL_PACING,
      removals: [{ ...result.removals[0], cutIndex: 59 }],
      skippedIds: [],
      notes: [],
    }).success,
    false,
  );
  const draft = createShortDraft(
    { id: "source", name: "source", duration: 5 } as StoredSource,
    "draft",
    "cut",
  );
  draft.pacingReview = {
    baseCuts: draft.cuts,
    options: NATURAL_PACING,
    removals: suggestPacing(transcript, cuts, NATURAL_PACING).removals,
    skippedIds: [],
    notes: [],
  };
  assert.deepEqual(
    restoreShortDrafts({ version: 1, drafts: [draft] })[0].pacingReview,
    draft.pacingReview,
  );
  draft.pacingReview.baseCuts = [{ id: "cut", start: "invalid", end: "5" }];
  assert.equal(
    restoreShortDrafts({ version: 1, drafts: [draft] })[0].pacingReview,
    undefined,
  );
});

test("local pacing endpoint protects source access and returns reviewable removals", async () => {
  const saved = state.sources,
    id = "aacaa565-781a-440c-b0bf-8b76f167e0c8";
  state.sources = [{ id, duration: 5, hasAudio: true } as StoredSource];
  const app = express();
  app.use(express.json());
  installPacingRoutes(app, async () => transcript);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const post = (body: unknown) =>
    fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shorts/pacing`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  const body = { sourceId: id, cuts, options: NATURAL_PACING };
  try {
    assert.equal(
      (await post({ ...body, filePath: "/private/source" })).status,
      400,
    );
    assert.equal(
      (await post({ ...body, cuts: [{ start: 0, end: 6 }] })).status,
      400,
    );
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).removals.length, 1);
  } finally {
    state.sources = saved;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "pacing exports preserve audio and duration with click-reducing join fades",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "remix-pacing-"));
    try {
      const input = path.join(directory, "input.mp4"),
        output = path.join(directory, "paced.mp4");
      await runLocal(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x90:r=25:d=5",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=5",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-threads",
          "1",
          "-c:a",
          "aac",
          "-shortest",
          input,
        ],
        { timeout: 10000 },
      );
      const removals = suggestPacing(transcript, cuts, {
        ...NATURAL_PACING,
        removeFillers: true,
      }).removals;
      const segments = applyPacing(cuts, removals),
        expected = segments.reduce((sum, cut) => sum + cut.end - cut.start, 0);
      await renderVideo({
        input,
        output,
        source: await probeMedia(input),
        workDir: directory,
        settings: { ...DEFAULT_SETTINGS, segments, smoothCuts: true },
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      const result = await probeMedia(output);
      assert.equal(result.hasAudio, true);
      assert.ok(
        Math.abs(result.duration - expected) < 0.15,
        `${result.duration} vs ${expected}`,
      );
      const pcm = path.join(directory, "audio.f32");
      await runLocal(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          output,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "f32le",
          pcm,
        ],
        { timeout: 10000 },
      );
      const samples = await readFile(pcm);
      const rms = (start: number, end: number) => {
        let sum = 0,
          count = 0;
        for (
          let index = Math.round(start * 48000);
          index < Math.round(end * 48000);
          index++
        ) {
          sum += samples.readFloatLE(index * 4) ** 2;
          count++;
        }
        return Math.sqrt(sum / count);
      };
      let boundary = 0;
      for (const segment of segments.slice(0, -1)) {
        boundary += segment.end - segment.start;
        assert.ok(
          rms(boundary - 0.001, boundary + 0.001) <
            rms(boundary - 0.035, boundary - 0.015) * 0.7,
          "The join should be quieter than the surrounding tone",
        );
      }
      const normalized = path.join(directory, "normalized.mp4");
      await renderVideo({
        input: output,
        output: normalized,
        source: result,
        workDir: directory,
        settings: {
          ...DEFAULT_SETTINGS,
          segments: [
            { start: 0, end: 1 },
            { start: 2, end: 3 },
          ],
          speed: 1.25,
          normalizeAudio: true,
          smoothCuts: true,
        },
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      const stereo = await probeMedia(normalized);
      assert.equal(stereo.hasAudio, true);
      assert.ok(
        Math.abs(stereo.duration - 1.6) < 0.15,
        "Stereo joins, playback speed and normalization preserve duration",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
