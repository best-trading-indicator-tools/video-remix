import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { newTextOverlay, textOverlaysSchema, TEXT_FONT_METRICS } from "../shared/text-overlays.js";
import { DEFAULT_SETTINGS, type EditPlan } from "../shared/types.js";
import { settingsSchema, autoOptionsSchema } from "../server/schema.js";
import { textOverlaysAss } from "../server/text-overlays.js";
import { applyEditPlanChanges } from "../server/edit-plan.js";
import { autoPicturePreview } from "../shared/preview-settings.js";
import { captureFinishingPreset } from "../shared/finishing-presets.js";
import { renderVideo, probeMedia } from "../server/engine.js";

test("preview/export font metrics stay aligned with the bundled font files", async () => {
  const files = { poppins: "Poppins-Regular.ttf", anton: "Anton-Regular.ttf", "tiktok-sans": "TikTokSans16pt-Regular.ttf", serif: "DMSerifDisplay-Regular.ttf" };
  for (const [family, file] of Object.entries(files)) {
    const font = await readFile(new URL(`../public/caption-fonts/${file}`, import.meta.url));
    const tables: Record<string, number> = {};
    for (let i = 0; i < font.readUInt16BE(4); i++) { const at = 12 + i * 16; tables[font.toString("ascii", at, at + 4)] = font.readUInt32BE(at + 8); }
    const em = font.readUInt16BE(tables.head! + 18), metrics = TEXT_FONT_METRICS[family as keyof typeof TEXT_FONT_METRICS];
    assert.equal(metrics.ascent, font.readUInt16BE(tables["OS/2"]! + 74) / em);
    assert.equal(metrics.descent, font.readUInt16BE(tables["OS/2"]! + 76) / em);
  }
});

test("text survives Auto/Manual settings and revisions independently from captions; finish presets omit its words", () => {
  const items = [newTextOverlay(randomUUID(), 5, 8)];
  assert.deepEqual(settingsSchema.parse({ ...DEFAULT_SETTINGS, textOverlays: items }).textOverlays, items);
  const auto = autoOptionsSchema.parse({ textOverlays: items });
  assert.deepEqual(autoPicturePreview(auto).textOverlays, items);
  assert.equal(settingsSchema.parse(DEFAULT_SETTINGS).textOverlays, undefined);
  const plan: EditPlan = { version: 1, revision: 0, sourceId: "source", sourceDuration: 10, outputDuration: 10, createdAt: "2026-10-12T00:00:00Z",
    settings: { ...DEFAULT_SETTINGS, captionStyle: { fontSize: 15, bottomPercent: 10 } }, cuts: [{ start: 0, end: 10 }],
    captions: [{ id: "speech", start: 1, end: 2, text: "Spoken words" }], visuals: [], media: [], narration: false };
  const edited = applyEditPlanChanges(plan, { revision: 0, textOverlays: items });
  assert.deepEqual(edited.settings.textOverlays, items);
  assert.deepEqual(edited.captions, plan.captions);
  assert.deepEqual(edited.settings.captionStyle, plan.settings.captionStyle);
  assert.equal(plan.settings.textOverlays, undefined);
  const shortened = applyEditPlanChanges(edited, { revision: edited.revision, cuts: [{ start: 0, end: 7 }] });
  assert.deepEqual(shortened.settings.textOverlays, items, "Output timestamps remain fixed when cuts change");
  assert.deepEqual(applyEditPlanChanges(edited, { revision: edited.revision, textOverlays: [] }).settings.textOverlays, []);
  assert.equal("textOverlays" in captureFinishingPreset("manual", "Style", edited.settings, "style").settings, false);
});

test("text rejects invalid timing, duplicate identities, control characters and unsafe styles; ASS keeps text literal", () => {
  const item = newTextOverlay(randomUUID());
  for (const patch of [{ start: -1 }, { end: 0 }, { end: Infinity }, { xPercent: NaN }, { widthPercent: 100 }, { text: "bad\0text" }, { style: { ...item.style, color: "red:movie=x" } }])
    assert.equal(textOverlaysSchema.safeParse([{ ...item, ...patch }]).success, false);
  assert.equal(textOverlaysSchema.safeParse([item, item]).success, false);
  const ass = textOverlaysAss([{ ...item, text: "{\\pos(1,1)} Literal\\N\nNext line" }], 640, 360, 2);
  assert.equal(ass.includes("{\\pos(1,1)}"), false);
  assert.ok(ass.includes("Literal\\\u200bN"));
  assert.ok(ass.includes("Next line"));
  assert.ok(ass.includes("0:00:02.00"), "Text clips at the actual output end");
});

test("export pixels honor independent text styles and output timing across a sped-up source and appended clip", { timeout: 60000 }, async () => {
  const exec = promisify(execFile), dir = await mkdtemp(path.join(tmpdir(), "text-overlays-"));
  const ffmpeg = (...args: string[]) => exec("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  try {
    const input = path.join(dir, "source.mp4"), outro = path.join(dir, "outro.mp4");
    for (const file of [input, outro]) await ffmpeg("-f", "lavfi", "-i", "color=black:s=640x360:r=25:d=2", "-c:v", "libx264", "-threads", "1", file);
    const source = await probeMedia(input);
    const first = newTextOverlay(randomUUID(), .4, 1.8), second = newTextOverlay(randomUUID(), 1.2, 2.4);
    first.text = "RED"; first.style = { ...first.style, color: "#ff0000", bottomPercent: 65, fontFamily: "anton" };
    second.text = "GREEN"; second.style = { ...second.style, color: "#00ff00", bottomPercent: 15, fontFamily: "serif", italic: true, background: "box", backgroundColor: "#0000ff", backgroundOpacity: 100 };
    const placement = { id: randomUUID(), assetId: randomUUID(), mode: "insert" as const, at: 0, appendToEnd: true, start: 0, end: 2, audio: "mute" as const, fit: "contain" as const };
    const output = path.join(dir, "output.mp4");
    await renderVideo({ input, output, source, settings: { ...DEFAULT_SETTINGS, speed: 2, ownFootage: [placement], textOverlays: [first, second] },
      ownFootage: [{ placement, path: outro, name: "Outro", duration: 2, hasAudio: false }], workDir: dir, signal: new AbortController().signal, onProgress() {} });
    assert.ok(Math.abs((await probeMedia(output)).duration - 3) < .1);
    for (const [time, red, green] of [[.2, false, false], [.6, true, false], [1.4, true, true], [2, false, true], [2.6, false, false]] as const) {
      const pixels = (await ffmpeg("-ss", String(time), "-i", output, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1")).stdout;
      let reds = 0, greens = 0, blues = 0, redY = 0, greenY = 0;
      for (let i = 0; i < pixels.length; i += 3) {
        const y = Math.floor(i / 3 / 640), r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        if (r > 160 && g < 100 && b < 100) { reds++; redY += y; }
        if (g > 160 && r < 100 && b < 100) { greens++; greenY += y; }
        if (b > 160 && r < 100 && g < 100) blues++;
      }
      assert.equal(reds > 30, red, `Red timing at ${time}s`);
      assert.equal(greens > 30, green, `Green timing at ${time}s`);
      assert.equal(blues > 30, green, `Optional background at ${time}s`);
      if (red && green) assert.ok(redY / reds < greenY / greens, "Independent vertical placement");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
