import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { captionsAfterInserts, footageTimeline, ownFootageSchema, type OwnFootagePlacement } from "../shared/own-footage.js";
import { probeMedia, renderVideo } from "../server/engine.js";

const exec = promisify(execFile);
const placement = (overrides: Partial<OwnFootagePlacement> = {}): OwnFootagePlacement => ({
  id: randomUUID(), assetId: randomUUID(), at: 2, start: 0, end: 2, mode: "insert", audio: "clip", fit: "contain", ...overrides,
});
test("footage placement validation and caption timing preserve the underlying edit clock", () => {
  const items = [placement(), placement({ at: 99, end: 1 })];
  assert.equal(footageTimeline(items, 6).duration, 9);
  const captions = captionsAfterInserts([{ id: "cue", start: 1, end: 4, text: "Original speech" }], items, 6, 30);
  assert.deepEqual(captions.map(item => [item.start, item.end]), [[1, 2], [4, 6]]);
  assert.equal(ownFootageSchema.safeParse([placement({ end: 0 })]).success, false);
  assert.equal(ownFootageSchema.safeParse([items[0], items[0]]).success, false);
});

test("uploaded clips insert picture and audio together, while cover shots retain original speech", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-own-footage-"));
  try {
    const source = path.join(directory, "source.mp4"), clip = path.join(directory, "clip.mp4");
    for (const [file, color, frequency, duration] of [[source, "red", 440, 6], [clip, "blue", 880, 2]] as const)
      await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=320x180:r=24:d=${duration}`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${duration}`, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    const metadata = await probeMedia(source);
    for (const mode of ["insert", "cover"] as const) {
      const item = placement({ mode });
      const output = path.join(directory, `${mode}.mp4`);
      await renderVideo({ input: source, output, source: metadata, settings: { ...DEFAULT_SETTINGS, ownFootage: [item] },
        ownFootage: [{ placement: item, path: clip, name: "My footage", duration: 2, hasAudio: true }],
        workDir: directory, signal: new AbortController().signal, onProgress: () => {} });
      const rendered = await probeMedia(output);
      assert.ok(Math.abs(rendered.duration - (mode === "insert" ? 8 : 6)) < 0.1);
      const frame = (await exec("ffmpeg", ["-v", "error", "-ss", "2.5", "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
      assert.ok(frame[2]! > frame[0]! + 50, "The inserted/cover picture is blue");
      const audio = (await exec("ffmpeg", ["-v", "error", "-ss", "2.4", "-i", output, "-t", "1", "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1"], { encoding: "buffer" })).stdout;
      let crossings = 0;
      for (let i = 2; i < audio.length; i += 2) if (audio.readInt16LE(i - 2) < 0 && audio.readInt16LE(i) >= 0) crossings++;
      assert.ok(Math.abs(crossings - (mode === "insert" ? 880 : 440)) < 12, `Unexpected audio: ${crossings} Hz`);
    }
    const silent = path.join(directory, "silent.mp4");
    await exec("ffmpeg", ["-v", "error", "-i", source, "-an", "-c:v", "copy", silent]);
    const inserts = [0, 3, 99].map(at => placement({ at }));
    for (const muted of [false, true]) {
      const output = path.join(directory, `multiple-${muted}.mp4`);
      await renderVideo({ input: silent, output, source: { ...metadata, hasAudio: false },
        settings: { ...DEFAULT_SETTINGS, muted, ownFootage: inserts },
        ownFootage: inserts.map(item => ({ placement: item, path: clip, name: "My footage", duration: 2, hasAudio: true })),
        workDir: directory, signal: new AbortController().signal, onProgress: () => {} });
      const result = await probeMedia(output);
      assert.ok(Math.abs(result.duration - 12) < 0.1, "Beginning, middle and appended footage keep a continuous timeline");
      assert.equal(result.hasAudio, !muted, "Inserted sound works with silent originals and respects the export mute control");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
