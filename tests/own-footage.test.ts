import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { captionsAfterInserts, footageTimeline, ownFootageSchema, resolveFootagePlacement, type OwnFootagePlacement } from "../shared/own-footage.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { manualPreviewSettings } from "../server/manual-preview.js";

const exec = promisify(execFile);
const placement = (overrides: Partial<OwnFootagePlacement> = {}): OwnFootagePlacement => ({
  id: randomUUID(), assetId: randomUUID(), at: 2, start: 0, end: 2, mode: "insert", audio: "clip", fit: "contain", ...overrides,
});

test("whole-clip outros follow the final edit length, after timed insertions, in list order", () => {
  const first = resolveFootagePlacement(placement({ appendToEnd: true, at: 99, start: 1, end: 1.5 }), 4);
  const second = resolveFootagePlacement(placement({ appendToEnd: true }), 2);
  const middle = placement({ at: 1, end: 1 });
  assert.deepEqual([first.at, first.start, first.end], [0, 0, 4]);
  for (const duration of [3, 12]) {
    const timeline = footageTimeline([first, middle, second], duration);
    assert.deepEqual(timeline.inserts.map(item => item.id), [middle.id, first.id, second.id]);
    assert.deepEqual(timeline.inserts.map(item => item.at), [1, duration, duration]);
    assert.equal(timeline.duration, duration + 7);
    assert.deepEqual(captionsAfterInserts([{ id: "last", start: duration - 1, end: duration, text: "Final words" }], [first, second], duration, 30)
      .map(cue => [cue.start, cue.end]), [[duration - 1, duration]]);
  }
  assert.equal(ownFootageSchema.safeParse([first]).success, true);
  assert.equal(ownFootageSchema.safeParse([{ ...first, mode: "cover" }]).success, false);
});

test("a five-second preview never moves a whole-clip outro ahead of the actual ending", () => {
  const source = { duration: 12, width: 320, height: 180, fps: 30, hasAudio: true };
  const outro = placement({ appendToEnd: true, at: 0 });
  const long = manualPreviewSettings({ ...DEFAULT_SETTINGS, ownFootage: [outro] }, source);
  assert.deepEqual(long.settings.ownFootage, []);
  const complete = manualPreviewSettings({ ...DEFAULT_SETTINGS, trimEnd: 3, ownFootage: [outro] }, source);
  assert.deepEqual(complete.settings.ownFootage, [outro]);
});

test("whole-clip append renders the entire picture and sound after trimmed and sped-up footage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-append-footage-"));
  try {
    const source = path.join(directory, "source.mp4"), clip = path.join(directory, "outro.mp4");
    for (const [file, color, frequency, duration] of [[source, "red", 440, 6], [clip, "blue", 880, 2]] as const)
      await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=320x180:r=30:d=${duration}`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${duration}`, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    const metadata = await probeMedia(source);
    // Stale manual trim/placement values must not shorten or reposition a whole-clip outro.
    const item = placement({ appendToEnd: true, at: 0, start: 0.5, end: 1 });
    for (const speed of [1, 2]) {
      const output = path.join(directory, `append-${speed}.mp4`);
      const baseDuration = 4 / speed;
      await renderVideo({ input: source, output, source: metadata,
        settings: { ...DEFAULT_SETTINGS, resolution: "source", speed, segments: [{ start: 1, end: 3 }, { start: 4, end: 6 }], ownFootage: [item] },
        ownFootage: [{ placement: item, path: clip, name: "My whole outro", duration: 2, hasAudio: true }],
        workDir: directory, signal: new AbortController().signal, onProgress: () => {} });
      assert.ok(Math.abs((await probeMedia(output)).duration - (baseDuration + 2)) < 0.1);
      for (const [time, channel] of [[0.5, 0], [baseDuration + 0.2, 2], [baseDuration + 1.8, 2]]) {
        const frame = (await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
        assert.ok(frame[channel]! > frame[2 - channel]! + 50, `Wrong picture at ${time}s`);
      }
      const audio = (await exec("ffmpeg", ["-v", "error", "-ss", String(baseDuration + 0.2), "-i", output, "-t", "1", "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1"], { encoding: "buffer" })).stdout;
      let crossings = 0;
      for (let i = 2; i < audio.length; i += 2) if (audio.readInt16LE(i - 2) < 0 && audio.readInt16LE(i) >= 0) crossings++;
      assert.ok(Math.abs(crossings - 880) < 12, "The outro keeps its own sound at normal speed");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("footage placement validation and caption timing preserve the underlying edit clock", () => {
  const items = [placement(), placement({ at: 99, end: 1 })];
  assert.equal(footageTimeline(items, 6).duration, 9);
  const captions = captionsAfterInserts([{ id: "cue", start: 1, end: 4, text: "Original speech" }], items, 6, 30);
  assert.deepEqual(captions.map(item => [item.start, item.end]), [[1, 2], [4, 6]]);
  assert.equal(ownFootageSchema.safeParse([placement({ end: 0 })]).success, false);
  assert.equal(ownFootageSchema.safeParse([items[0], items[0]]).success, false);
});

test("short silent inserts and outros render with clip audio selected and normalization enabled", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-silent-footage-"));
  try {
    const source = path.join(directory, "source.mp4");
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-shortest", source]);
    const metadata = await probeMedia(source);
    for (const kind of ["silent-track", "no-track", "stereo-tones"] as const) {
      const clip = path.join(directory, `${kind}.mp4`);
      await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=180x320:r=30:d=1.8",
        ...(kind === "no-track" ? [] : ["-f", "lavfi", "-i", kind === "silent-track"
          ? "anullsrc=r=44100:cl=stereo:d=1.8"
          : "aevalsrc=0.1*sin(2*PI*880*t)|0.1*sin(2*PI*1320*t):s=44100:d=1.8"]),
        "-c:v", "libx264", "-threads", "1", "-c:a", "aac", clip]);
      const media = await probeMedia(clip);
      assert.equal(media.hasAudio, kind !== "no-track");
      for (const appendToEnd of [true, false]) {
        const item = placement({ appendToEnd, at: 1, end: media.duration });
        const output = path.join(directory, `${kind}-${appendToEnd}.mp4`);
        await renderVideo({ input: source, output, source: metadata,
          settings: { ...DEFAULT_SETTINGS, resolution: "source", normalizeAudio: true, ownFootage: [item] },
          ownFootage: [{ placement: item, path: clip, name: kind, ...media }],
          workDir: directory, signal: AbortSignal.timeout(10_000), onProgress: () => {} });
        const rendered = await probeMedia(output);
        assert.ok(Math.abs(rendered.duration - 4.8) < 0.1, "The full clip adds its duration");
        assert.equal(rendered.hasAudio, true, "The original soundtrack remains present");
        const insertedAt = appendToEnd ? 3 : 1;
        const frame = (await exec("ffmpeg", ["-v", "error", "-ss", String(insertedAt + 0.4), "-i", output,
          "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
        assert.ok(frame[2]! > frame[0]! + 50, "The inserted picture remains visible");
        for (const time of [0.2, insertedAt + 0.2, ...(!appendToEnd ? [3.2] : [])]) {
          const audio = (await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output,
            "-t", "0.5", "-f", "s16le", "-ac", "2", "-ar", "8000", "pipe:1"], { encoding: "buffer" })).stdout;
          assert.ok(audio.length >= 7900, "The soundtrack covers the sampled interval");
          const inserted = time > insertedAt && time < insertedAt + 1.8;
          for (const channel of [0, 1]) {
            let peak = 0, crossings = 0;
            for (let i = channel * 2; i < audio.length; i += 4) {
              const sample = audio.readInt16LE(i);
              peak = Math.max(peak, Math.abs(sample));
              if (i >= 4 && audio.readInt16LE(i - 4) < 0 && sample >= 0) crossings++;
            }
            if (inserted && kind !== "stereo-tones") assert.ok(peak <= 1, "Silent footage stays silent");
            else {
              assert.ok(peak > 1000, "Audible clips keep their sound");
              const frequency = inserted ? (channel === 0 ? 880 : 1320) : 440;
              assert.ok(Math.abs(crossings * 2 - frequency) < 12, "Original speech and both inserted audio channels are preserved");
            }
          }
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
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
