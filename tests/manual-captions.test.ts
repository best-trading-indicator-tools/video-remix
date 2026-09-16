import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Transcript } from "../shared/types.js";
import { captureFinishingPreset, restoreFinishingPresets } from "../shared/finishing-presets.js";
import { settingsSchema } from "../server/schema.js";
import { addManualCaptions } from "../server/manual-captions.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { parseCaptionCues } from "../server/edit-plan.js";

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const ffmpeg = (...args: string[]) => exec("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
const speech: Transcript = { language: "en", duration: 3, segments: [{ start: 0.2, end: 2.8, text: "Here is our final edited soundtrack",
  words: "Here is our final edited soundtrack".split(" ").map((word, i) => ({ word, start: 0.2 + i * 0.4, end: 0.6 + i * 0.4, probability: 0.99 })) }] };

test("manual caption modes survive API validation and finishing presets", () => {
  for (const automaticCaptions of ["off", "auto", "add"] as const) {
    const settings = { ...DEFAULT_SETTINGS, automaticCaptions };
    assert.equal(settingsSchema.parse(settings).automaticCaptions, automaticCaptions);
    const preset = captureFinishingPreset("manual", "My captions", settings, "caption-preset");
    assert.equal(restoreFinishingPresets(JSON.parse(JSON.stringify({ version: 1, presets: [preset] })))[0]?.settings.automaticCaptions, automaticCaptions);
  }
  assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, automaticCaptions: "invent" }).success, false);
});

test("automatic Manual captions use composed audio, preserve media, and avoid duplicate text", { timeout: 60000 }, async t => {
  const workDir = await mkdtemp(path.join(tmpdir(), "manual-captions-"));
  const original = path.join(workDir, "source.mp4"), edited = path.join(workDir, "edited.mp4"), output = path.join(workDir, "output.mp4");
  try {
    await ffmpeg("-f", "lavfi", "-i", "color=0x153040:s=320x180:r=24:d=6", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-c:v", "libx264", "-threads", "1", "-c:a", "aac", original);
    const source = await probeMedia(original);
    const settings = { ...DEFAULT_SETTINGS, segments: [{ start: 1, end: 3 }, { start: 4, end: 6 }], speed: 2,
      automaticCaptions: "add" as const, captionStyle: { fontSize: 28, bottomPercent: 20, color: "#ffdd00", fontFamily: "poppins" as const } };
    await renderVideo({ input: original, output: edited, source, settings, workDir, signal: signal(), onProgress: () => {} });
    const finalMedia = await probeMedia(edited);
    assert.ok(Math.abs(finalMedia.duration - 2) < 0.15);
    const audioPackets = async (file: string) => (await ffmpeg("-i", file, "-map", "0:a:0", "-c", "copy", "-f", "adts", "pipe:1")).stdout;
    const pixels = async (file: string) => (await ffmpeg("-ss", "0.8", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")).stdout;
    const options = { output, settings, workDir, signal: signal(), onPhase: () => {} };
    const editedSpeech = { ...speech, duration: 2, segments: [{ ...speech.segments[0]!, end: 1.8,
      words: speech.segments[0]!.words.map(word => ({ ...word, start: word.start / 1.5, end: word.end / 1.5 })) }] };
    const transcribe = async (request: { input: string }) => {
      assert.equal(request.input, output, "Listen to the finished export, not the original source");
      assert.deepEqual(await audioPackets(request.input), await audioPackets(edited));
      return editedSpeech;
    };
    await t.test("caption styling reaches MP4 pixels and leaves audio packets, size, rate and duration intact", async () => {
      await copyFile(edited, output);
      const result = await addManualCaptions(options, { available: async () => true, transcribe,
        inspect: async () => { throw new Error("Force-add should not run OCR"); } });
      const cues = parseCaptionCues(await readFile(result.subtitlePath!, "utf8"));
      assert.ok(cues.length > 0 && cues.every(cue => cue.end <= finalMedia.duration));
      const captioned = await probeMedia(output);
      assert.equal(captioned.width, finalMedia.width); assert.equal(captioned.height, finalMedia.height);
      assert.equal(captioned.fps, finalMedia.fps); assert.ok(Math.abs(captioned.duration - finalMedia.duration) < 0.05);
      assert.deepEqual(await audioPackets(output), await audioPackets(edited));
      const before = await pixels(edited), after = await pixels(output);
      assert.notDeepEqual(after, before);
      let yellow = 0;
      for (let i = 0; i < after.length; i += 3) if (after[i]! > 160 && after[i + 1]! > 140 && after[i + 2]! < 100) yellow++;
      assert.ok(yellow > 20, "Selected yellow caption color is visible in the rendered frame");
      assert.ok(!(await readdir(workDir)).some(name => name.startsWith("caption-fonts-")));
    });
    for (const status of ["detected", "uncertain", "unavailable"] as const) await t.test(`${status} existing captions leave the export byte-for-byte unchanged`, async () => {
      await copyFile(edited, output);
      const result = await addManualCaptions({ ...options, settings: { ...settings, automaticCaptions: "auto" } }, {
        available: async () => true, transcribe, inspect: async request => {
          assert.equal(request.source.filePath, output);
          assert.equal(request.cuts[0]?.end, finalMedia.duration);
          return { status, sampledFrames: 3, reason: "Test inspection" };
        } });
      assert.equal(result.subtitlePath, undefined); assert.match(result.note, /No new captions were added/);
      assert.deepEqual(await readFile(output), await readFile(edited));
    });
    await t.test("automatic mode adds captions only after a clean picture check", async () => {
      await copyFile(edited, output);
      const result = await addManualCaptions({ ...options, settings: { ...settings, automaticCaptions: "auto" } }, {
        available: async () => true, transcribe, inspect: async () => ({ status: "not-detected", sampledFrames: 12 }) });
      assert.ok(result.subtitlePath);
    });
    await t.test("missing model fails clearly without changing the export", async () => {
      await copyFile(edited, output);
      await assert.rejects(addManualCaptions(options, { available: async () => false }), /npm run setup:auto/);
      assert.deepEqual(await readFile(output), await readFile(edited));
    });
    await t.test("no usable speech adds no captions", async () => {
      const result = await addManualCaptions(options, { available: async () => true, transcribe: async () => ({ duration: 2, language: "en", segments: [] }) });
      assert.equal(result.subtitlePath, undefined); assert.match(result.note, /No usable speech/);
    });
    await t.test("silent output skips transcription and pre-cancelled work stops", async () => {
      await ffmpeg("-i", edited, "-c:v", "copy", "-an", output);
      const result = await addManualCaptions(options, { available: async () => { throw new Error("Should not need the model"); } });
      assert.equal(result.subtitlePath, undefined); assert.match(result.note, /no audio/);
      await assert.rejects(addManualCaptions({ ...options, signal: AbortSignal.abort() }), { name: "AbortError" });
    });
  } finally { await rm(workDir, { recursive: true, force: true }); }
});
