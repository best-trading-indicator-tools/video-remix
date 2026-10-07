import assert from "node:assert/strict";
import { test } from "node:test";
import { captureMyStyle, describeMyStyle, restoreMyStyle, styleAuto, styleManual } from "../shared/my-style.js";
import { CAPTION_PRESETS } from "../shared/caption-style.js";
import { audioLookById, DEFAULT_AUDIO_SETTINGS } from "../shared/audio.js";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, type AutoOptions, type RemixSettings } from "../shared/types.js";
import type { PacingOptions } from "../shared/pacing.js";

const TIGHT_PACING: PacingOptions = { mode: "tight", minimumPause: 0.6, keepPause: 0.22, removeFillers: false };
const punch = CAPTION_PRESETS.find(preset => preset.id === "punch")!.style;
const bands = { enabled: true, fit: "contain" as const, topPercent: 30, bottomPercent: 12, topText: "My channel headline", bottomText: "", fontPercent: 6 };
const styled: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, captionStyle: punch, blackBands: bands, pacing: TIGHT_PACING, audio: "clear", targetDuration: 20 };

test("your style keeps the look and leaves each video's words, length and versions out", () => {
  const style = captureMyStyle(styled, "2026-09-29T10:00:00.000Z");
  assert.deepEqual(style, { version: 1, savedAt: "2026-09-29T10:00:00.000Z", captionStyle: punch,
    blackBands: { enabled: true, fit: "contain", topPercent: 30, bottomPercent: 12, fontPercent: 6 }, pacing: TIGHT_PACING, audio: "clear" });
  assert.deepEqual(restoreMyStyle(JSON.parse(JSON.stringify(style))), style);
  assert.equal(restoreMyStyle({ ...style, topText: "smuggled" }), null, "Unknown fields are rejected");
  assert.equal(restoreMyStyle({}), null);
  assert.deepEqual(describeMyStyle(style), ["Punch captions", "Black bands 30% / 12%", "Tight pacing", "Clear voice sound"]);
  assert.deepEqual(describeMyStyle(captureMyStyle(DEFAULT_AUTO_OPTIONS)), ["Default captions", "No black bands", "Natural pacing", "Measured sound"]);
});

test("applying your style to Auto keeps each video's band text, length, versions mode and visuals", () => {
  const style = captureMyStyle(styled);
  const video: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, targetDuration: 60, versionMode: "angles", visualSources: ["pexels"],
    blackBands: { ...bands, enabled: false, topText: "This video's own headline", topPercent: 20 } };
  const result = styleAuto(video, style);
  assert.equal(result.targetDuration, 60);
  assert.equal(result.versionMode, "angles");
  assert.deepEqual(result.visualSources, ["pexels"]);
  assert.deepEqual(result.captionStyle, punch);
  assert.deepEqual(result.pacing, TIGHT_PACING);
  assert.equal(result.audio, "clear");
  assert.deepEqual(result.blackBands, { ...bands, topText: "This video's own headline" });
  assert.notEqual(result.captionStyle, style.captionStyle, "The saved style is copied, not shared");
});

test("saved styles retain Cyrillic spelling rules without treating them as a different built-in look", () => {
  const options = { ...styled, captionStyle: { ...punch, cyrillicMode: "words" as const, cyrillicWords: ["Sample-12"] } };
  const style = restoreMyStyle(JSON.parse(JSON.stringify(captureMyStyle(options))))!;
  assert.equal(describeMyStyle(style)[0], "Punch captions · Cyrillic lookalikes");
  assert.deepEqual(styleAuto(DEFAULT_AUTO_OPTIONS, style).captionStyle, options.captionStyle);
  assert.deepEqual(styleManual(DEFAULT_SETTINGS, style).captionStyle, options.captionStyle);
});

test("applying your style to Manual keeps cuts, color and text, and maps only pinned sound looks", () => {
  const manual: RemixSettings = { ...DEFAULT_SETTINGS, speed: 1.2, saturation: 1.4, segments: [{ start: 2, end: 9 }],
    blackBands: { ...bands, topText: "Manual headline", enabled: false }, denoise: 0.9 };
  const result = styleManual(manual, captureMyStyle(styled));
  assert.equal(result.speed, 1.2);
  assert.equal(result.saturation, 1.4);
  assert.deepEqual(result.segments, [{ start: 2, end: 9 }]);
  assert.deepEqual(result.captionStyle, punch);
  assert.equal(result.blackBands?.topText, "Manual headline");
  assert.equal(result.blackBands?.enabled, true);
  for (const [key, value] of Object.entries(audioLookById("clear")!.adjustments)) assert.equal(result[key as keyof RemixSettings], value, key);
  const measured = styleManual(manual, captureMyStyle({ ...styled, audio: "auto" }));
  assert.equal(measured.denoise, 0.9, "Manual has no measured sound, so it keeps its own");
  const original = styleManual(manual, captureMyStyle({ ...styled, audio: "off" }));
  for (const [key, value] of Object.entries(DEFAULT_AUDIO_SETTINGS)) assert.equal(original[key as keyof RemixSettings], value, key);
});
