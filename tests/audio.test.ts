import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  AUDIO_LOOKS,
  AUDIO_LOOK_KEYS,
  AUDIO_RANGES,
  MAX_AUDIO_FADE,
  activeAudioLook,
  applyAudioLook,
  audioAdjustments,
  audioLookBars,
  audioLookById,
  audioTargets,
  chooseAudioLook,
  type AudioAnalysis,
} from "../shared/audio.js";
import { audioFadeFilters, audioModifierFilters } from "../server/audio-filters.js";
import { analyzeAudio } from "../server/audio-analysis.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { settingsSchema } from "../server/schema.js";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";

let directory: string;
let clean: string;
let noisy: string;
let clip: string;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
      { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

// Half-second tone bursts separated by pauses, over a noise floor: the pauses
// are what makes a floor measurable, exactly as they are in recorded speech.
const bursts = (noise: number) =>
  `aevalsrc='0.3*sin(2*PI*300*t)*lt(mod(t\\,1.0)\\,0.5)+${noise}*(random(0)-0.5)':s=32000:d=10`;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "video-remix-audio-"));
  clean = path.join(directory, "clean.wav");
  noisy = path.join(directory, "noisy.wav");
  clip = path.join(directory, "clip.mp4");
  await ffmpeg(["-f", "lavfi", "-i", bursts(0.0008), clean]);
  await ffmpeg(["-f", "lavfi", "-i", bursts(0.06), noisy]);
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24:duration=3",
    "-f", "lavfi", "-i", bursts(0.02), "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", "-threads", "2", clip]);
});

after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("every sound look stays inside its slider bounds and can be identified again", () => {
  assert.equal(new Set(AUDIO_LOOKS.map(look => look.id)).size, AUDIO_LOOKS.length);
  assert.equal(AUDIO_LOOKS[0]!.id, "original");
  for (const look of AUDIO_LOOKS) {
    for (const key of AUDIO_LOOK_KEYS) {
      const [low, high] = AUDIO_RANGES[key];
      const value = look.adjustments[key];
      assert.ok(value >= low && value <= high, `${look.id}.${key} is outside ${low}–${high}`);
    }
    const applied = applyAudioLook(DEFAULT_SETTINGS, look.id);
    assert.equal(activeAudioLook(applied), look.id);
    // A look owns tone only; it must not touch loudness, framing or timing.
    for (const key of ["volume", "muted", "speed", "aspect", "trimStart", "normalizeAudio"] as const)
      assert.deepEqual(applied[key], DEFAULT_SETTINGS[key]);
    assert.equal(audioLookBars(look.adjustments).length, 5);
    assert.ok(audioLookBars(look.adjustments).every(bar => bar > 0 && bar <= 1));
  }
  assert.equal(applyAudioLook(DEFAULT_SETTINGS, "not-a-look"), DEFAULT_SETTINGS);
  assert.equal(activeAudioLook({ ...DEFAULT_SETTINGS, denoise: 0.123 }), null);
});

test("missing and invalid modifiers read as neutral", () => {
  assert.deepEqual(audioAdjustments({}), audioAdjustments({ denoise: 0, lowCut: 0 }));
  assert.equal(audioAdjustments({ denoise: 9 }).denoise, 1);
  assert.equal(audioAdjustments({ bass: -9 }).bass, -1);
  assert.equal(audioAdjustments({ treble: Number.NaN }).treble, 0);
  assert.equal(activeAudioLook(DEFAULT_SETTINGS), "original");
});

/**
 * Measured with FFmpeg from a reference speech recording and six variants of it,
 * as window percentiles and band means relative to the full band. These fixtures
 * are what the selection thresholds were calibrated against; changing a
 * threshold should be a deliberate decision about these cases.
 */
const MEASURED: [string, AudioAnalysis, string][] = [
  ["clean speech", { quietDb: -53.2, medianDb: -27.7, loudDb: -21.7, lowDb: -15.3, bodyDb: -4.3, presenceDb: -3.3, airDb: -10.6 }, "original"],
  ["hiss", { quietDb: -38.5, medianDb: -31.6, loudDb: -21.7, lowDb: -15.6, bodyDb: -4.7, presenceDb: -3.6, airDb: -8.8 }, "cleanup"],
  ["heavy hiss", { quietDb: -26.5, medianDb: -25.5, loudDb: -20.6, lowDb: -16.9, bodyDb: -7, presenceDb: -5.2, airDb: -3.7 }, "cleanup"],
  ["rumble", { quietDb: -23.4, medianDb: -21.9, loudDb: -19, lowDb: -1.2, bodyDb: -9.9, presenceDb: -9.5, airDb: -16.8 }, "clear"],
  ["sibilant", { quietDb: -71.6, medianDb: -29, loudDb: -18.1, lowDb: -19, bodyDb: -8, presenceDb: -5.9, airDb: -3 }, "smooth"],
  ["muffled", { quietDb: -76.8, medianDb: -35.2, loudDb: -24.6, lowDb: -12.7, bodyDb: -2, presenceDb: -5.1, airDb: -21.8 }, "bright"],
  ["uneven delivery", { quietDb: -62, medianDb: -36.6, loudDb: -24.9, lowDb: -15.4, bodyDb: -4.4, presenceDb: -3.4, airDb: -10.6 }, "podcast"],
];

test("measured recordings select the look that answers what was measured", () => {
  for (const [name, analysis, expected] of MEASURED) {
    const choice = chooseAudioLook(analysis);
    assert.equal(choice.id, expected, `${name} should choose ${expected}, chose ${choice.id}`);
    assert.equal(choice.name, audioLookById(expected)!.name);
    assert.ok(choice.reason.length > 0);
  }
  // Creative treatments are offered in the editor but never chosen for anyone.
  assert.ok(!AUDIO_LOOKS.find(look => look.id === "phone")!.automatic);
  assert.ok(MEASURED.every(([, analysis]) => chooseAudioLook(analysis).id !== "phone"));
});

test("targets stay bounded and rumble is not treated as hiss", () => {
  for (const [, analysis] of MEASURED) {
    const targets = audioTargets(analysis);
    for (const key of AUDIO_LOOK_KEYS) {
      const [low, high] = AUDIO_RANGES[key];
      assert.ok(targets[key] >= low && targets[key] <= high);
    }
    assert.ok(targets.denoise <= 0.8, "automatic denoising stops short of the maximum");
  }
  const rumble = MEASURED.find(([name]) => name === "rumble")![1];
  const hiss = MEASURED.find(([name]) => name === "hiss")![1];
  assert.ok(audioTargets(rumble).lowCut > 0.9);
  assert.ok(audioTargets(rumble).denoise < audioTargets(hiss).denoise);
  assert.deepEqual(audioTargets({ quietDb: Number.NaN, medianDb: 0, loudDb: 0, lowDb: Number.NaN, bodyDb: 0, presenceDb: 0, airDb: 0 }).lowCut, 0);
});

test("neutral settings add no audio filters and a look adds them in mixing order", () => {
  assert.deepEqual(audioModifierFilters({}), []);
  assert.deepEqual(audioModifierFilters(audioAdjustments({})), []);
  const filters = audioModifierFilters(audioLookById("clear")!.adjustments);
  const names = filters.map(filter => filter.split("=")[0]);
  assert.deepEqual(names, ["highpass", "afftdn", "equalizer", "treble", "deesser", "acompressor"]);
  // Every generated value must be a finite number FFmpeg can parse.
  for (const look of AUDIO_LOOKS)
    for (const filter of audioModifierFilters(look.adjustments))
      for (const value of filter.matchAll(/=(-?[\d.]+)(?=[:,]|$)/gu))
        assert.ok(Number.isFinite(Number(value[1])), `${look.id}: ${filter}`);
  const extremes = Object.fromEntries(
    AUDIO_LOOK_KEYS.map(key => [key, AUDIO_RANGES[key][1]])) as Record<(typeof AUDIO_LOOK_KEYS)[number], number>;
  assert.equal(audioModifierFilters(extremes).length, AUDIO_LOOK_KEYS.length);
});

test("fades are measured against the export and cannot meet in the middle", () => {
  const settings = (fadeIn: number, fadeOut: number): RemixSettings => ({ ...DEFAULT_SETTINGS, fadeIn, fadeOut });
  assert.deepEqual(audioFadeFilters(settings(0, 0), 10), []);
  assert.deepEqual(audioFadeFilters(settings(1.5, 2), 10), ["afade=t=in:st=0:d=1.5", "afade=t=out:st=8:d=2"]);
  assert.deepEqual(audioFadeFilters(settings(MAX_AUDIO_FADE, MAX_AUDIO_FADE), 4),
    ["afade=t=in:st=0:d=2", "afade=t=out:st=2:d=2"]);
  assert.deepEqual(audioFadeFilters(settings(1, 1), 0), []);
});

test("the request schema accepts modifiers and rejects values outside their range", () => {
  const parsed = settingsSchema.parse({ ...DEFAULT_SETTINGS, denoise: 0.4, bass: -0.5, fadeOut: 2 });
  assert.deepEqual([parsed.denoise, parsed.bass, parsed.fadeOut], [0.4, -0.5, 2]);
  assert.ok(settingsSchema.safeParse({ ...DEFAULT_SETTINGS }).success, "edits saved before sound looks stay valid");
  for (const invalid of [{ denoise: 1.2 }, { denoise: -0.1 }, { bass: 2 }, { deEss: Number.NaN },
    { fadeIn: -1 }, { fadeOut: MAX_AUDIO_FADE + 1 }, { presence: "loud" }])
    assert.ok(!settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...invalid }).success, JSON.stringify(invalid));
});

test("measuring a recording separates its noise floor from its speech", async () => {
  const [quiet, loud] = await Promise.all([analyzeAudio(clean, {}), analyzeAudio(noisy, {})]);
  assert.ok(quiet && loud, "both fixtures are measurable");
  assert.ok(loud.quietDb > quiet.quietDb + 20, "the noisy fixture has the louder floor");
  assert.ok(Math.abs(loud.loudDb - quiet.loudDb) < 3, "both fixtures speak at the same level");
  assert.ok(audioTargets(loud).denoise > audioTargets(quiet).denoise);
  assert.equal(audioTargets(quiet).denoise, 0);
  assert.equal(await analyzeAudio(path.join(directory, "missing.wav"), {}), null);
});

test("an export carries its sound look and fades without losing audio", async () => {
  const source = await probeMedia(clip);
  const output = path.join(directory, "treated.mp4");
  await renderVideo({
    input: clip, output, source, workDir: directory, onProgress: () => {},
    signal: AbortSignal.timeout(120_000),
    settings: { ...DEFAULT_SETTINGS, ...audioLookById("cleanup")!.adjustments, fadeIn: 0.3, fadeOut: 0.5,
      normalizeAudio: true, trimStart: 0, trimEnd: 2 },
  });
  const info = await probeMedia(output);
  assert.ok(info.hasAudio, "the treated export keeps its soundtrack");
  assert.ok(Math.abs(info.duration - 2) < 0.2, `expected about 2 seconds, got ${info.duration}`);
  await assert.rejects(renderVideo({
    input: clip, output: path.join(directory, "invalid.mp4"), source, workDir: directory,
    onProgress: () => {}, signal: AbortSignal.timeout(30_000),
    settings: { ...DEFAULT_SETTINGS, denoise: 4 },
  }), /Invalid denoise setting/);
});
