import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { moveTextOverlay, newTextOverlay, textOverlaysSchema, TEXT_FONT_METRICS } from "../shared/text-overlays.js";
import { DEFAULT_SETTINGS, type EditPlan } from "../shared/types.js";
import { settingsSchema, autoOptionsSchema } from "../server/schema.js";
import { textOverlaysAss } from "../server/text-overlays.js";
import { applyEditPlanChanges } from "../server/edit-plan.js";
import { autoPicturePreview } from "../shared/preview-settings.js";
import { captureFinishingPreset } from "../shared/finishing-presets.js";
import { renderVideo, probeMedia } from "../server/engine.js";

test("canvas dragging scales with the displayed frame, reverses the bottom axis and stays within export bounds", () => {
  const start = { xPercent: 50, bottomPercent: 45 };
  assert.deepEqual(moveTextOverlay(start, 27, -46.5, 270, 465), { xPercent: 60, bottomPercent: 55 });
  assert.deepEqual(moveTextOverlay(start, 54, -93, 540, 930), moveTextOverlay(start, 27, -46.5, 270, 465));
  assert.deepEqual(moveTextOverlay(start, -1000, 1000, 270, 465), { xPercent: 5, bottomPercent: 5 });
  assert.deepEqual(moveTextOverlay(start, 1000, -1000, 270, 465), { xPercent: 95, bottomPercent: 80 });
  for (const size of [[0, 465], [270, 0], [NaN, 465], [270, Infinity]]) assert.deepEqual(moveTextOverlay(start, 10, 10, size[0]!, size[1]!), start);
});

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

test("multiline text backgrounds render as one uniformly translucent rectangle without moving the lettering", { timeout: 30000 }, async () => {
  const exec = promisify(execFile), dir = await mkdtemp(path.join(tmpdir(), "text-background-"));
  const width = 640, height = 360;
  const frame = async (item: ReturnType<typeof newTextOverlay>) => {
    const ass = path.join(dir, "text.ass");
    await writeFile(ass, textOverlaysAss([item], width, height, 1));
    return (await exec("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=black:s=${width}x${height}:r=1:d=1`,
      "-vf", "format=rgb24,subtitles=filename=text.ass:fontsdir=fonts", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { cwd: dir, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 })).stdout;
  };
  try {
    await cp(new URL("../public/caption-fonts", import.meta.url), path.join(dir, "fonts"), { recursive: true });
    for (const [fontFamily, alignment, opacity] of [["poppins", "center", 80], ["anton", "left", 40], ["serif", "right", 80], ["tiktok-sans", "center", 100]] as const) {
      const item = newTextOverlay(randomUUID()); item.text = "I\nWider text";
      item.style = { ...item.style, fontFamily, alignment, italic: fontFamily === "serif", background: "box", backgroundColor: "#0000ff", backgroundOpacity: opacity, outlineWidth: 0 };
      const pixels = await frame(item);
      let left = width, right = -1, top = height, bottom = -1;
      const white: number[] = [];
      for (let i = 0; i < pixels.length; i += 3) {
        const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!], x = i / 3 % width, y = Math.floor(i / 3 / width);
        if (b > 70 && r < 20 && g < 20) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
        if (Math.min(r, g, b) > 245) white.push(i);
      }
      assert.ok(right - left > 70 && bottom - top > 40, `${fontFamily}: background covers both unequal lines`);
      for (let y = top + 2; y <= bottom - 2; y++) for (const x of [left + 2, right - 2]) {
        const i = (y * width + x) * 3;
        // Italic strokes can reach into the padding; account for their white fill.
        const expectedBlue = pixels[i]! + (255 - pixels[i]!) * opacity / 100;
        assert.ok(Math.abs(pixels[i]! - pixels[i + 1]!) < 2 && Math.abs(pixels[i + 2]! - expectedBlue) < 4,
          `${fontFamily}: continuous rectangle with uniform opacity at ${x},${y}`);
      }
      const plain = await frame({ ...item, style: { ...item.style, background: "none" } });
      const plainWhite = Array.from({ length: width * height }, (_, pixel) => pixel * 3).filter(i => Math.min(plain[i]!, plain[i + 1]!, plain[i + 2]!) > 245);
      assert.ok(white.length > 30);
      assert.deepEqual(white, plainWhite, `${fontFamily}: adding a box preserves glyph positions`);
      const transparent = await frame({ ...item, style: { ...item.style, backgroundOpacity: 0 } });
      assert.deepEqual(transparent, plain, `${fontFamily}: zero opacity leaves no background`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
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
