import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import type { SupportingVisual } from "../server/visuals.js";

const exec = promisify(execFile);
const ffmpeg = (args: string[]) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", ...args], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
let directory: string;
let landscape: string;
let portrait: string;
let black: string;
let captions: string;
let serial = 0;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "remix-framing-"));
  landscape = path.join(directory, "left red middle blue right green.mp4");
  portrait = path.join(directory, "top red middle blue bottom green.mp4");
  black = path.join(directory, "black.mp4");
  captions = path.join(directory, "captions.srt");
  for (const [output, source, filter] of [
    [landscape, "color=blue:size=360x180:rate=24:duration=6", "drawbox=x=0:y=0:w=120:h=180:color=red:t=fill,drawbox=x=240:y=0:w=120:h=180:color=lime:t=fill"],
    [portrait, "color=blue:size=180x360:rate=24:duration=2", "drawbox=x=0:y=0:w=180:h=120:color=red:t=fill,drawbox=x=0:y=240:w=180:h=120:color=lime:t=fill"],
    [black, "color=black:size=180x320:rate=24:duration=2", "null"],
  ]) await ffmpeg(["-f", "lavfi", "-i", source!, "-vf", filter!, "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", output!]);
  await writeFile(captions, "1\n00:00:00,000 --> 00:00:01,800\nCAPTION\n", "utf8");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function render(input: string, changes: Partial<RemixSettings>, supportingVisuals?: SupportingVisual[], subtitlePath?: string) {
  const output = path.join(directory, `framed-${++serial}.mp4`);
  await renderVideo({ input, output, source: await probeMedia(input), settings: { ...DEFAULT_SETTINGS, ...changes },
    workDir: path.join(directory, `work-${serial}`), supportingVisuals, subtitlePath,
    signal: new AbortController().signal, onProgress: () => undefined });
  return output;
}
async function pixel(input: string, time: number, x?: number, y?: number) {
  const filter = x === undefined ? "scale=1:1" : `crop=2:2:${x}:${y},scale=1:1`;
  const { stdout } = await ffmpeg(["-ss", String(time), "-i", input, "-frames:v", "1", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  return [...stdout];
}
const red = (rgb: number[]) => assert.ok(rgb[0]! > 220 && rgb[1]! < 25 && rgb[2]! < 25, `Expected the red subject, received ${rgb}`);
const green = (rgb: number[]) => assert.ok(rgb[1]! > 220 && rgb[0]! < 25 && rgb[2]! < 25, `Expected the green subject, received ${rgb}`);
const blue = (rgb: number[]) => assert.ok(rgb[2]! > 220 && rgb[0]! < 25 && rgb[1]! < 25, `Expected the blue subject, received ${rgb}`);

test("per-cut subjects follow reordered accelerated footage and fall back to the global focal point", async () => {
  const output = await render(landscape, {
    aspect: "9:16", speed: 2, focalPoint: { x: 0.5, y: 0.5 },
    segments: [
      { start: 2, end: 4, focalPoint: { x: 0.15, y: 0.5 } },
      { start: 0, end: 2, focalPoint: { x: 0.85, y: 0.5 } },
      { start: 4, end: 6 },
    ],
  });
  assert.ok(Math.abs((await probeMedia(output)).duration - 3) < 0.1);
  red(await pixel(output, 0.4));
  green(await pixel(output, 1.4));
  blue(await pixel(output, 2.4));
});

test("mirroring retains the selected original subject, zoom honors its point, and edge coordinates clamp", async () => {
  const mirrored = await render(landscape, { aspect: "9:16", trimEnd: 1, focalPoint: { x: 0.15, y: 0.5 }, mirror: true });
  red(await pixel(mirrored, 0.5));
  const zoomed = await render(landscape, { aspect: "9:16", trimEnd: 1, zoom: 2, focalPoint: { x: 1, y: 0.5 } });
  green(await pixel(zoomed, 0.5));
  const vertical = await render(portrait, { aspect: "16:9", trimEnd: 1, focalPoint: { x: 0.5, y: 1 } });
  green(await pixel(vertical, 0.5));
});

test("blur fit keeps the whole foreground instead of applying an aspect crop to its focal point", async () => {
  const output = await render(landscape, { aspect: "9:16", fit: "blur", trimEnd: 1, focalPoint: { x: 1, y: 0.5 } });
  const dimensions = await probeMedia(output);
  red(await pixel(output, 0.5, 20, Math.floor(dimensions.height / 2)));
  green(await pixel(output, 0.5, dimensions.width - 22, Math.floor(dimensions.height / 2)));
});

test("supporting footage uses its own focal point and returns to the main framing", async () => {
  const output = await render(landscape, { aspect: "9:16", trimEnd: 2, focalPoint: { x: 0.5, y: 0.5 } }, [
    { path: landscape, kind: "broll", label: "Right subject", start: 0.5, end: 1.5, sourceStart: 2, focalPoint: { x: 0.85, y: 0.5 } },
  ]);
  blue(await pixel(output, 0.2));
  green(await pixel(output, 0.8));
  blue(await pixel(output, 1.8));
});

async function whiteBounds(input: string) {
  const metadata = await probeMedia(input);
  const { stdout } = await ffmpeg(["-ss", "0.5", "-i", input, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  let top = metadata.height, bottom = -1, count = 0;
  for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) {
    const offset = (y * metadata.width + x) * 3;
    if (stdout[offset]! > 180 && stdout[offset + 1]! > 180 && stdout[offset + 2]! > 180) {
      top = Math.min(top, y); bottom = Math.max(bottom, y); count++;
    }
  }
  assert.ok(count > 50, "The rendered frame must contain actual white caption glyphs");
  return { top, bottom, height: bottom - top + 1, frameHeight: metadata.height };
}

test("caption percentage and font size move and scale actual rendered glyphs on the ASS canvas", async () => {
  const low = await render(black, { trimEnd: 1, captionStyle: { fontSize: 20, bottomPercent: 10 } }, undefined, captions);
  const raised = await render(black, { trimEnd: 1, captionStyle: { fontSize: 20, bottomPercent: 40 } }, undefined, captions);
  const larger = await render(black, { trimEnd: 1, captionStyle: { fontSize: 32, bottomPercent: 10 } }, undefined, captions);
  const a = await whiteBounds(low), b = await whiteBounds(raised), c = await whiteBounds(larger);
  const expectedShift = a.frameHeight * 0.3;
  assert.ok(Math.abs((a.bottom - b.bottom) - expectedShift) <= 3,
    `Changing the margin by30% should move glyphs by${expectedShift}px on the actual output; measured${a.bottom - b.bottom}px`);
  assert.ok(Math.abs(a.height - b.height) <= 1, "Position alone must not change font size");
  assert.ok(c.height >= a.height * 1.4 && c.height <= a.height * 1.8, `Font20 to32 should enlarge glyphs: ${a.height}px to${c.height}px`);
});

test("invalid focal points and caption settings fail before rendering", async () => {
  for (const changes of [
    { focalPoint: { x: -0.1, y: 0.5 } },
    { focalPoint: { x: 0.5, y: 1.1 } },
    { focalPoint: { x: NaN, y: 0.5 } },
    { focalPoint: { x: "iw;movie=/private/file", y: 0.5 } },
    { focalPoint: null },
    { segments: [{ start: 0, end: 1, focalPoint: { x: 0.5, y: Infinity } }] },
    { captionStyle: { fontSize: 11, bottomPercent: 10 } },
    { captionStyle: { fontSize: 41, bottomPercent: 10 } },
    { captionStyle: { fontSize: 20, bottomPercent: 81 } },
    { captionStyle: { fontSize: 20, bottomPercent: 4 } },
    { captionStyle: { fontSize: NaN, bottomPercent: 10 } },
  ]) await assert.rejects(render(landscape, changes as Partial<RemixSettings>), /Focal points|Caption style/u);
  await assert.rejects(render(landscape, { trimEnd: 2 }, [{
    path: landscape, kind: "broll", label: "Invalid", start: 0.5, end: 1.5, focalPoint: { x: 2, y: 0.5 },
  }]), /Supporting visuals/u);
});

test("caption fonts, colors, outlines, alignment and translucent boxes change real exported pixels", async () => {
  const fontSource = path.join(directory, "caption-hd.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=black:size=720x1280:rate=10:duration=1", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", fontSource]);
  const styledCaptions = path.join(directory, "styled.srt");
  await writeFile(styledCaptions, "1\n00:00:00,000 --> 00:00:01,800\n<font color=\"#ffffff\">Hi</font>\n");
  const style = { fontSize: 20, bottomPercent: 20, fontFamily: "poppins" as const, color: "#ff0000", outlineColor: "#00ff00", outlineWidth: 2 };
  const scan = async (file: string) => {
    const { width } = await probeMedia(file);
    const { stdout } = await ffmpeg(["-ss", "0.5", "-i", file, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    let redCount = 0, greenCount = 0, blueCount = 0, redX = 0;
    for (let i = 0; i < stdout.length; i += 3) {
      const [r, g, b] = [stdout[i]!, stdout[i + 1]!, stdout[i + 2]!];
      if (r > 150 && g < 100 && b < 100) { redCount++; redX += i / 3 % width; }
      if (g > 140 && r < 110 && b < 110) greenCount++;
      if (b > 140 && r < 110 && g < 110) blueCount++;
    }
    return { redCount, greenCount, blueCount, redX: redX / Math.max(1, redCount), width, pixels: stdout };
  };
  const renderStyle = async (patch: Partial<NonNullable<RemixSettings["captionStyle"]>>) => scan(await render(fontSource,
    { trimEnd: 1, captionStyle: { ...style, ...patch } }, undefined, styledCaptions));
  const left = await renderStyle({ alignment: "left" }), right = await renderStyle({ alignment: "right" });
  assert.ok(left.redCount > 30 && left.greenCount > 30, `Selected red fill and green outline override embedded SRT styling: red=${left.redCount}, green=${left.greenCount}`);
  assert.ok(right.redX - left.redX > left.width * 0.4, "Alignment must move actual glyphs");
  const anton = await renderStyle({ alignment: "left", fontFamily: "anton" });
  assert.notDeepEqual(anton.pixels, left.pixels, "Bundled font choice changes rendered letterforms");
  const bold = await renderStyle({ alignment: "left", bold: true });
  assert.ok(bold.redCount > left.redCount, "The bundled bold face adds real glyph weight");
  const box = await renderStyle({ background: "box", backgroundColor: "#0000ff", backgroundOpacity: 100 });
  const transparent = await renderStyle({ background: "box", backgroundColor: "#0000ff", backgroundOpacity: 0 });
  assert.ok(box.blueCount > 100, "The background uses its chosen color");
  assert.equal(transparent.blueCount, 0, "A fully transparent box must not cover the video");
  const upper = await renderStyle({ alignment: "left", uppercase: true, italic: true, letterSpacing: 1, shadow: 1 });
  assert.notDeepEqual(upper.pixels, left.pixels, "Uppercase, italic and spacing reach the render");
});
