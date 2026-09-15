import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizedSettings } from "../server/schema.js";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import { activeColorLook, applyColorLook, COLOR_LOOK_KEYS, coerceManualNumber, MANUAL_LOOKS, manualPreviewInterval, manualCropPosition } from "../shared/manual.js";

const settings = (patch: Partial<RemixSettings> = {}): RemixSettings => ({ ...DEFAULT_SETTINGS, ...patch });

test("switching color looks preserves the complete edit outside color and texture", () => {
  const edited = settings({
    speed: 1.25, volume: 0.75, muted: true, zoom: 1.3, blend: 0.4, frameBlend: 0.15,
    timeShift: 1.2, mirror: true, aspect: "9:16", fit: "blur", resolution: "720", fps: "60",
    trimStart: 3, trimEnd: 21, hookText: "The useful part", hookDuration: 4,
    stripMetadata: false, device: "none", audioId: "7bcbe212-f745-4d82-94a3-dcf8d6e2ac1",
    subtitleId: "bb245db4-39c7-46b9-bbdd-26180db16415",
    segments: [{ start: 3, end: 9, focalPoint: { x: 0.3, y: 0.4 } }],
    callouts: [{ text: "A supporting detail", start: 1, end: 3 }],
    normalizeAudio: true, autoMotion: true, focalPoint: { x: 0.25, y: 0.4 },
    captionStyle: { fontSize: 23, bottomPercent: 18 },
  });
  const before = structuredClone(edited);
  const untouched = (value: RemixSettings) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(COLOR_LOOK_KEYS as readonly string[]).includes(key)));
  for (const look of MANUAL_LOOKS) {
    const changed = applyColorLook(edited, look.id);
    assert.deepEqual(untouched(changed), untouched(before), look.name);
    assert.equal(activeColorLook(changed), look.id);
    assert.notEqual(changed, edited);
  }
  assert.deepEqual(edited, before, "Applying a look cannot mutate the existing edit");
  assert.equal(applyColorLook(edited, "removed-custom-look"), edited, "Unknown persisted IDs leave the edit intact");
});

test("all eight looks produce valid settings and switching looks clears previous look adjustments", () => {
  assert.deepEqual(MANUAL_LOOKS.map((look) => look.name), ["Neutral", "Clean", "Warm", "Cool", "Muted", "Monochrome", "Film", "Vivid"]);
  for (const look of MANUAL_LOOKS) {
    const applied = applyColorLook(settings(), look.id);
    assert.deepEqual(normalizedSettings(applied), applied, look.name);
  }
  const film = applyColorLook(settings({ blend: 0.7 }), "film");
  assert.ok(film.noise > 0);
  const vivid = applyColorLook(film, "vivid");
  assert.equal(vivid.noise, 0, "Film grain is cleared when choosing a clean look");
  assert.equal(vivid.blend, 0.7, "Temporal blending is preserved when changing the color look");
  assert.deepEqual(applyColorLook(vivid, "neutral"), settings({ blend: 0.7 }));
});

test("active looks ignore framing and sound while detecting custom color and texture", () => {
  assert.equal(activeColorLook(settings({ aspect: "9:16", muted: true, blend: 0.5, frameBlend: 0.3 })), "neutral");
  for (const key of COLOR_LOOK_KEYS) {
    assert.equal(activeColorLook(settings({ [key]: DEFAULT_SETTINGS[key] + 0.011 })), null, key);
  }
  assert.equal(activeColorLook(settings({ saturation: Number.NaN })), null);
});

test("numeric controls retain incomplete input, clamp boundaries and quantize precise steps", () => {
  for (const input of ["", " ", "-", "not a number", "NaN", "Infinity", "-Infinity", "1e999"])
    assert.equal(coerceManualNumber(input, 0.4, -1, 1), 0.4, input);
  assert.equal(coerceManualNumber("-0.256", 0, -1, 1), -0.26);
  assert.equal(coerceManualNumber(" 0.3333 ", 0, 0, 1, 0.001), 0.333);
  assert.equal(coerceManualNumber("99", 1, 0.5, 2), 2);
  assert.equal(coerceManualNumber("-99", 1, 0.5, 2), 0.5);
  assert.equal(coerceManualNumber("0.3", 0, 0, 1, 0.1), 0.3, "No binary-float residue");
  assert.equal(coerceManualNumber("0.12", 0, -0.05, 1, 0.1), 0.15, "Steps start at the minimum");
  assert.equal(coerceManualNumber("0.125", 0, 0, 1, 0.01), 0.13, "Half steps round upward");
  assert.equal(coerceManualNumber("0.0000014", 0, 0, 1, 1e-6), 0.000001);
  assert.equal(coerceManualNumber("0.25", 0.4, 1, -1), 0.4);
  assert.equal(coerceManualNumber("0.25", 0.4, -1, 1, 0), 0.4);
});

test("manual preview uses the same shifted source window and playback duration as rendering", () => {
  assert.deepEqual(manualPreviewInterval(settings({ trimStart: 4, trimEnd: 10, timeShift: 2, speed: 1.5 }), 20),
    { start: 6, end: 12, sourceDuration: 6, outputDuration: 4 });
  assert.deepEqual(manualPreviewInterval(settings({ trimStart: 1, trimEnd: 7, timeShift: -5, speed: 0.5 }), 20),
    { start: 0, end: 6, sourceDuration: 6, outputDuration: 12 });
  assert.deepEqual(manualPreviewInterval(settings({ trimStart: 12, trimEnd: 18, timeShift: 5 }), 20),
    { start: 14, end: 20, sourceDuration: 6, outputDuration: 6 });
  assert.deepEqual(manualPreviewInterval(settings({ timeShift: 5, speed: 2 }), 20),
    { start: 0, end: 20, sourceDuration: 20, outputDuration: 10 });
  assert.deepEqual(manualPreviewInterval(settings({ trimStart: 5, trimEnd: 25, timeShift: -3 }), 20),
    { start: 2, end: 17, sourceDuration: 15, outputDuration: 15 }, "Engine caps an explicit end at the source duration");
  assert.deepEqual(manualPreviewInterval(settings({ trimStart: 5, timeShift: 3 }), 20),
    { start: 5, end: 20, sourceDuration: 15, outputDuration: 15 }, "An open end already touches the final source frame");
});

test("invalid and discontinuous selections do not produce a misleading single preview window", () => {
  for (const patch of [
    { trimStart: 20 }, { trimStart: 5, trimEnd: 4 }, { trimEnd: 0.04 },
    { trimStart: -1 }, { trimStart: Number.NaN }, { trimEnd: Number.POSITIVE_INFINITY },
    { timeShift: Number.NaN }, { speed: 0 }, { speed: Number.POSITIVE_INFINITY },
    { segments: [{ start: 1, end: 2 }, { start: 8, end: 10 }] },
  ]) assert.equal(manualPreviewInterval(settings(patch), 20), null, JSON.stringify(patch));
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.equal(manualPreviewInterval(settings(), duration), null);
});

test("manual crop positioning keeps the focal point centered until the source edges prevent it", () => {
  assert.equal(manualCropPosition(1920, 1080, 9 / 16, { x: 0.5, y: 0.5 }), "50% 50%");
  assert.equal(manualCropPosition(1920, 1080, 9 / 16, { x: 0, y: 0 }), "0% 50%");
  assert.equal(manualCropPosition(1920, 1080, 9 / 16, { x: 1, y: 1 }), "100% 50%");
  assert.equal(manualCropPosition(1080, 1920, 16 / 9, { x: 0, y: 0 }), "50% 0%");
  assert.equal(manualCropPosition(1080, 1920, 16 / 9, { x: 1, y: 1 }), "50% 100%");
  assert.equal(manualCropPosition(1920, 1080, 16 / 9, { x: 0.1, y: 0.9 }), "50% 50%", "An uncropped source cannot move");
  const [position] = manualCropPosition(1920, 1080, 9 / 16, { x: 0.25, y: 0.8 }).split(" ");
  const cropWidth = 1080 * 9 / 16;
  const retainedCenter = parseFloat(position) / 100 * (1920 - cropWidth) + cropWidth / 2;
  assert.ok(Math.abs(retainedCenter - 1920 * 0.25) < 0.001, "A source focal point is not a raw CSS percentage");
  assert.equal(manualCropPosition(0, 0, 9 / 16, { x: 0.5, y: 0.5 }), "50% 50%");
  assert.equal(manualCropPosition(1920, 1080, Number.NaN, { x: 0.5, y: 0.5 }), "50% 50%");
});
