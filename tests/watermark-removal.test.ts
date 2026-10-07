import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import { DEFAULT_WATERMARK_REMOVAL, rasterizeMask, removalIntervals, watermarkRemovalSchema, type MaskStroke, type WatermarkRemoval } from "../shared/watermark-removal.js";
import { settingsSchema, autoOptionsSchema } from "../server/schema.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { manualPreviewSettings } from "../server/manual-preview.js";
import { captureFinishingPreset } from "../shared/finishing-presets.js";
import { validateWatermarkRemoval, watermarkFilters, WatermarkRemovalError } from "../server/watermark-removal.js";
import { canRetryRender } from "../server/job-recovery.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const rectangle = (x: number, y: number, w: number, h: number): MaskStroke => ({ kind: "rect", size: .04,
  points: [{ x: x / 320, y: y / 180 }, { x: (x + w) / 320, y: (y + h) / 180 }] });
const first = { id: "first", start: 1, end: 2, strokes: [rectangle(57, 32, 26, 16)] };
const second = { id: "second", start: 2, end: 3, strokes: [rectangle(217, 87, 26, 16)] };
const timed: WatermarkRemoval = { enabled: true, mode: "timed", masks: [first, second] };
const fixed: WatermarkRemoval = { enabled: true, mode: "fixed", masks: [first] };
const exec = promisify(execFile);
const ffmpeg = (args: string[], cwd?: string) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", ...args], { cwd, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
let directory: string, source: string, serial = 0;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "remix-watermark-")); source = path.join(directory, "source.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=blue:size=320x180:rate=24:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-vf", "drawbox=x=60:y=35:w=20:h=10:color=white:t=fill,drawbox=x=220:y=90:w=20:h=10:color=white:t=fill",
    "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function render(changes: Partial<RemixSettings>, input = source) {
  const output = path.join(directory, `out-${++serial}.mp4`), workDir = path.join(directory, `work-${serial}`);
  await renderVideo({ input, output, source: await probeMedia(input), settings: { ...DEFAULT_SETTINGS, ...changes }, workDir,
    signal: new AbortController().signal, onProgress: () => {} });
  assert.ok(!(await readdir(workDir)).some(name => name.endsWith(".pgm")), "Temporary masks must be cleaned up");
  return output;
}
async function pixel(file: string, time: number, x = 68, y = 38) {
  const { stdout } = await ffmpeg(["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},scale=1:1`, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  return [...stdout];
}
const blue = (value: number[]) => assert.ok(value[2]! > 200 && value[0]! < 55 && value[1]! < 55, `Expected reconstructed blue, got ${value}`);
const white = (value: number[]) => assert.ok(value.every(n => n > 220), `Expected intact watermark, got ${value}`);

test("defaults are off; Auto and Manual accept bounded masks and reject malformed or oversized data", () => {
  assert.equal(DEFAULT_WATERMARK_REMOVAL.enabled, false);
  assert.equal(autoOptionsSchema.parse({}).watermarkRemoval, undefined);
  assert.equal(settingsSchema.parse(DEFAULT_SETTINGS).watermarkRemoval, undefined);
  assert.deepEqual(autoOptionsSchema.parse({ watermarkRemoval: timed }).watermarkRemoval, timed);
  assert.deepEqual(settingsSchema.parse({ ...DEFAULT_SETTINGS, watermarkRemoval: timed }).watermarkRemoval, timed);
  for (const invalid of [
    { ...timed, mode: "tracking" }, { ...timed, masks: [first, first] }, { ...timed, masks: [{ ...first, end: first.start }] },
    { ...timed, masks: [{ ...first, strokes: [{ kind: "brush", size: .04, points: [{ x: NaN, y: 0 }] }] }] },
    { ...timed, masks: [{ ...first, strokes: [{ kind: "rect", size: .04, points: [{ x: 0, y: 0 }] }] }] },
    { ...timed, masks: [{ ...first, strokes: Array(101).fill(first.strokes[0]) }] },
    { ...timed, masks: [{ ...first, strokes: [{ kind: "brush", size: .04, points: Array(301).fill({ x: .5, y: .5 }) }] }] },
  ]) assert.equal(watermarkRemovalSchema.safeParse(invalid).success, false);
});

test("brush follows a continuous path, erasing preserves surrounding and cleared pixels", () => {
  const marks: MaskStroke[] = [{ kind: "brush", size: .1, points: [{ x: .2, y: .5 }, { x: .8, y: .5 }] },
    { kind: "erase", size: .15, points: [{ x: .5, y: .5 }] }];
  const pixels = rasterizeMask(marks, 200, 100);
  assert.equal(pixels[50 * 200 + 60], 255); assert.equal(pixels[50 * 200 + 100], 0);
  assert.equal(pixels[10 * 200 + 60], 0); assert.equal(pixels[50 * 200 + 140], 255);
});

test("source intervals map to reordered and repeated cuts after speed changes", () => {
  assert.deepEqual(removalIntervals(first, [{ start: 2, end: 3 }, { start: 0, end: 2 }, { start: 1, end: 2 }], 2), [
    { start: 1, end: 1.5 }, { start: 1.5, end: 2 },
  ]);
  for (const mode of ["auto", "manual"] as const) {
    const preset = captureFinishingPreset(mode, "My style", { ...DEFAULT_SETTINGS, watermarkRemoval: timed }, "test");
    assert.equal("watermarkRemoval" in preset.settings, false, "Source marks must never become a reusable finishing preset");
  }
});

test("fixed removal cleans only the marked logo on every frame and keeps audio", async () => {
  const file = await render({ watermarkRemoval: fixed });
  for (const time of [.3, 1.5, 3.5]) { blue(await pixel(file, time)); white(await pixel(file, time, 228, 94)); }
  blue(await pixel(file, .5, 150, 140));
  assert.equal((await probeMedia(file)).hasAudio, true);
});

test("OFF and completely erased masks leave source pixels unchanged", async () => {
  white(await pixel(await render({ watermarkRemoval: { ...fixed, enabled: false } }), .5));
  const erase: MaskStroke = { kind: "erase", size: .2, points: [{ x: 70 / 320, y: 40 / 180 }] };
  white(await pixel(await render({ watermarkRemoval: { ...fixed, masks: [{ ...first, strokes: [...first.strokes, erase] }] } }), .5));
});

test("timed masks switch on and off on the original source clock", async () => {
  const file = await render({ watermarkRemoval: timed });
  white(await pixel(file, .5)); blue(await pixel(file, 1.5)); white(await pixel(file, 2.5));
  white(await pixel(file, 1.5, 228, 94)); blue(await pixel(file, 2.5, 228, 94)); white(await pixel(file, 3.5, 228, 94));
});

test("trim, time shift, slow playback, and repeated/reordered cuts retain correct masks", async () => {
  const trim = await render({ watermarkRemoval: timed, trimStart: 0, trimEnd: 2, timeShift: 1, speed: .5 });
  blue(await pixel(trim, .5)); white(await pixel(trim, 2.5)); blue(await pixel(trim, 2.5, 228, 94));
  const cuts = await render({ watermarkRemoval: timed, speed: 2, segments: [{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 1, end: 2 }] });
  blue(await pixel(cuts, .2, 228, 94)); white(await pixel(cuts, .7)); blue(await pixel(cuts, 1.2)); blue(await pixel(cuts, 1.7));
});

test("preview samples use the same source-time masks as exports", async () => {
  const info = await probeMedia(source);
  const preview = manualPreviewSettings({ ...DEFAULT_SETTINGS, trimStart: 1, trimEnd: 3, watermarkRemoval: timed }, info);
  const file = await render(preview.settings);
  blue(await pixel(file, .2)); white(await pixel(file, 1.2)); blue(await pixel(file, 1.2, 228, 94));
});

test("removal runs before mirroring, crops, and black-band framing", async () => {
  const cropped = await render({ watermarkRemoval: fixed, aspect: "1:1" });
  blue(await pixel(cropped, .5, 6, 40)); white(await pixel(cropped, .5, 168, 94));
  const file = await render({ watermarkRemoval: fixed, mirror: true, blackBands: {
    enabled: true, fit: "contain", topPercent: 20, bottomPercent: 20, topText: "", bottomText: "", fontPercent: 5.4,
  } });
  // The 320x180 source fits at 60% scale: 64px side margins, 36px top band.
  blue(await pixel(file, .5, 64 + Math.floor((320 - 70) * .6), 36 + 24));
  white(await pixel(file, .5, 64 + Math.floor((320 - 230) * .6), 36 + 56));
});

test("Auto preparation carries source masks into its editable render settings", async () => {
  const { prepareAutoRemix } = await import("../server/auto.js");
  const workDir = path.join(directory, "auto"); await mkdir(workDir);
  const info: StoredSource = { ...await probeMedia(source), hasAudio: false, id: "source", filePath: source,
    thumbnailPath: "", thumbnailUrl: "", name: "source.mp4", size: 1, createdAt: new Date().toISOString() };
  const job: StoredJob = { id: "job", batchId: "batch", sourceId: info.id, sourceName: info.name, variant: 1, status: "processing", progress: 0,
    createdAt: info.createdAt, settings: { ...DEFAULT_SETTINGS }, auto: { aspect: "original", durationMode: "full", targetDuration: 4,
      narration: false, captions: "keep", audio: "off", visualSources: [], watermarkRemoval: timed } };
  const result = await prepareAutoRemix({ source: info, job, workDir, signal: new AbortController().signal, onPhase: () => {} });
  assert.deepEqual(result.settings.watermarkRemoval, timed);
  assert.notEqual(result.settings.watermarkRemoval, timed, "Job snapshots must not share mutable brush arrays");
  const file = await render(result.settings);
  blue(await pixel(file, 1.5)); blue(await pixel(file, 2.5, 228, 94));
});

test("oversized selections fail clearly and leave no temporary masks", async () => {
  await assert.rejects(render({ watermarkRemoval: { ...fixed, masks: [{ ...first, strokes: [rectangle(0, 0, 300, 160)] }] } }), /covers more than 25%/);
  assert.ok(!(await readdir(path.join(directory, `work-${serial}`))).some(name => name.endsWith(".pgm")));
});

// Regression: this real selection covered only 5% of a 1080x1920 source, but
// rounding made it 193px high, crossing the old absolute radius limit by 1px.
const reported: WatermarkRemoval = { enabled: true, mode: "fixed", masks: [{ id: "reported", start: 0, end: 1,
  strokes: [{ kind: "rect", size: .04, points: [{ x: .2457, y: .11553 }, { x: .7431, y: .21541 }] }] }] };
async function portraitFixture(scale = 1) {
  const input = path.join(directory, `portrait-${scale}.mp4`);
  await ffmpeg(["-f", "lavfi", "-i", `color=blue:size=${1080 * scale}x${1920 * scale}:rate=8:duration=1`,
    "-vf", `drawgrid=w=8:h=8:t=1:color=red,drawbox=x=0:y=0:w=iw:h=${700 * scale}:color=blue:t=fill,` +
      `drawbox=x=${300 * scale}:y=${250 * scale}:w=${450 * scale}:h=${130 * scale}:color=white:t=fill`,
    "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", input]);
  return input;
}
test("a 5% selection is removed at HD and 4K without reducing export dimensions", async () => {
  for (const scale of [1, 2]) {
    const input = await portraitFixture(scale);
    const output = await render({ watermarkRemoval: reported, trimEnd: .375, aspect: "original" }, input);
    blue(await pixel(output, .1, 500 * scale, 300 * scale));
    const info = await probeMedia(output);
    assert.equal(info.width, 1080 * scale); assert.equal(info.height, 1920 * scale);
  }
});
test("adaptive reconstruction preserves unmarked detail, erased pixels and source-time ranges", async () => {
  const input = await portraitFixture();
  const removal: WatermarkRemoval = { ...reported, mode: "timed", masks: [{ ...reported.masks[0]!, start: .5, end: .875,
    strokes: [...reported.masks[0]!.strokes, { kind: "erase", size: .04, points: [{ x: .5, y: 300 / 1920 }] }] }] };
  const output = await render({ watermarkRemoval: removal, aspect: "original" }, input);
  white(await pixel(output, .1, 350, 300)); blue(await pixel(output, .6, 350, 300));
  white(await pixel(output, .6, 540, 300)); white(await pixel(output, .9, 350, 300));
  const workDir = path.join(directory, "adaptive-pixels"); await mkdir(workDir);
  const filters = await watermarkFilters(reported, 1080, 1920, [{ start: 0, end: 1 }], 1, workDir, [], new AbortController().signal);
  // Compare decoded pixels before encoding, so H.264 quantization does not hide
  // accidental down/upscaling of the untouched checker grid.
  const sample = async (prefix: string) => (await ffmpeg(["-i", input, "-filter_complex", `${prefix}crop=100:100:400:900`,
    "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"], workDir)).stdout;
  assert.deepEqual(await sample(`[0:v]${filters.join(",")},`), await sample("[0:v]"));
});
test("watermark validation errors require attention instead of automatic retry", () => {
  const large: WatermarkRemoval = { ...fixed, masks: [{ ...first, strokes: [rectangle(0, 0, 300, 160)] }] };
  assert.throws(() => validateWatermarkRemoval(large, 320, 180), error => {
    assert.ok(error instanceof WatermarkRemovalError); assert.equal(canRetryRender(error), false); return true;
  });
  assert.doesNotThrow(() => validateWatermarkRemoval({ ...large, enabled: false }, 320, 180));
  assert.doesNotThrow(() => validateWatermarkRemoval(reported, 2160, 3840));
});
