import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { manualPreviewSettings } from "../server/manual-preview.js";

const exec = promisify(execFile);
const ffmpeg = (args: string[]) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-y", ...args], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
async function luminance(file: string, time: number) {
  const { stdout } = await ffmpeg(["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "crop=2:2:iw/2:ih/2,format=gray", "-f", "rawvideo", "pipe:1"]);
  return [...stdout].reduce((sum, pixel) => sum + pixel, 0) / stdout.length;
}

test("moving crops use the source clock through reordered cuts, repeats, speed and preview truncation", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-focus-render-"));
  try {
    const input = path.join(directory, "gradient.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "nullsrc=s=320x180:r=20:d=8,geq=lum='16+219*X/W':cb=128:cr=128", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", input]);
    const source = await probeMedia(input);
    const settings: RemixSettings = { ...DEFAULT_SETTINGS, aspect: "9:16", fit: "crop", resolution: "source", speed: 2,
      segments: [
        { start: 6, end: 8, focusTrack: [{ time: 6, x: 0.2, y: 0.5 }, { time: 8, x: 0.8, y: 0.5 }] },
        { start: 1, end: 3, focusTrack: [{ time: 1, x: 0.8, y: 0.5 }, { time: 3, x: 0.2, y: 0.5 }] },
        { start: 6, end: 8, focalPoint: { x: 0.65, y: 0.5 } },
      ] };
    const render = async (name: string, chosen: RemixSettings, chosenSource = source) => {
      const output = path.join(directory, `${name}.mp4`);
      await renderVideo({ input, output, settings: chosen, source: chosenSource,
        workDir: path.join(directory, name), signal: AbortSignal.timeout(20000), onProgress: () => {} });
      return output;
    };
    const output = await render("fast", settings);
    assert.equal((await probeMedia(output)).height, 180);
    for (const [time, x] of [[0.25, 0.35], [0.75, 0.65], [1.25, 0.65], [1.75, 0.35], [2.25, 0.65], [2.75, 0.65]]) {
      const observed = await luminance(output, time);
      assert.ok(Math.abs(observed - x * 255) < 13, `At ${time}s the crop should center near source x=${x}, got luminance ${observed}`);
    }
    const slow = { ...settings, speed: 0.5 };
    const full = await render("slow", slow);
    const bounded = manualPreviewSettings(slow, source);
    assert.equal(bounded.duration, 5);
    assert.equal(bounded.settings.segments!.length, 2);
    const preview = await render("preview", bounded.settings, bounded.source);
    for (const time of [0.5, 3.5, 4.5]) assert.ok(Math.abs(await luminance(full, time) - await luminance(preview, time)) < 4,
      "A five-second preview must use the same camera position as the full export, even when it ends inside a cut");
    const invalid = { ...settings, segments: [{ start: 0, end: 1, focusTrack: [{ time: 2, x: 0.5, y: 0.5 }] }] };
    await assert.rejects(render("invalid", invalid), /Focus tracks/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dense focus tracks render without exceeding FFmpeg expression nesting", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-focus-budget-"));
  try {
    const input = path.join(directory, "source.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90:r=12:d=1", "-c:v", "libx264", "-threads", "1", input]);
    const output = path.join(directory, "output.mp4");
    await renderVideo({ input, output, source: await probeMedia(input),
      settings: { ...DEFAULT_SETTINGS, aspect: "9:16", fit: "crop", resolution: "source", segments: [0, 1].map(index => ({ start: 0, end: 1,
        focusTrack: Array.from({ length: 120 }, (_, point) => ({ time: point / 119, x: 0.5 + Math.sin(point / 10 + index) * 0.2, y: 0.5 })) })) },
      workDir: path.join(directory, "work"), signal: AbortSignal.timeout(20000), onProgress: () => {} });
    assert.ok(Math.abs((await probeMedia(output)).duration - 2) < 0.1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
