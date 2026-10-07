import assert from "node:assert/strict";
import { test } from "node:test";
import { captionStyleSchema, captionAssStyle, CAPTION_PRESETS, DEFAULT_CAPTION_STYLE } from "../shared/caption-style.js";
import { autoOptionsSchema, settingsSchema } from "../server/schema.js";
import { captureFinishingPreset, restoreFinishingPresets } from "../shared/finishing-presets.js";
import { DEFAULT_SETTINGS, DEFAULT_AUTO_OPTIONS } from "../shared/types.js";

test("caption styling preserves legacy records and round-trips through Auto, manual and saved presets", () => {
  const old = { fontSize: 20, bottomPercent: 100 / 12 };
  assert.deepEqual(captionStyleSchema.parse(old), old);
  assert.equal(captionAssStyle(old), captionAssStyle(DEFAULT_CAPTION_STYLE));
  const tiktokStyles = [false, true].flatMap(bold => [false, true].map(italic => ({ ...DEFAULT_CAPTION_STYLE, fontFamily: 'tiktok-sans' as const, bold, italic })));
  for (const style of [...CAPTION_PRESETS.map(preset => preset.style), ...tiktokStyles]) {
    assert.deepEqual(settingsSchema.parse({ ...DEFAULT_SETTINGS, captionStyle: style }).captionStyle, style);
    assert.deepEqual(autoOptionsSchema.parse({ ...DEFAULT_AUTO_OPTIONS, captionStyle: style }).captionStyle, style);
    for (const mode of ["auto", "manual"] as const) {
      const saved = captureFinishingPreset(mode, "Caption look", { ...(mode === "auto" ? DEFAULT_AUTO_OPTIONS : DEFAULT_SETTINGS), captionStyle: style }, "preset");
      assert.deepEqual(restoreFinishingPresets(JSON.parse(JSON.stringify({ version: 1, presets: [saved] })))[0]?.settings.captionStyle, style);
    }
  }
});

test("caption styling rejects unsafe font names, colors, unsupported options and out-of-range effects", () => {
  for (const patch of [
    { fontFamily: "Poppins,FontSize=900" }, { fontFamily: "/private/font.ttf" }, { color: "red" },
    { color: "#ffffff:movie=/private" }, { outlineColor: "#fff" }, { backgroundColor: "url(secret)" },
    { outlineWidth: 6 }, { shadow: -1 }, { letterSpacing: Infinity }, { bold: "true" },
    { backgroundOpacity: 101 }, { alignment: "top" }, { fontUrl: "https://untrusted.test/font" },
  ]) assert.equal(captionStyleSchema.safeParse({ ...DEFAULT_CAPTION_STYLE, ...patch }).success, false);
  assert.match(captionAssStyle({ ...DEFAULT_CAPTION_STYLE, color: "#123456" }), /PrimaryColour=&H00563412/u);
});
