import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { renderVideo, probeMedia } from "../server/engine.js";

const run = promisify(execFile);

test("a conclusion-first edit renders the replayed ending before the whole moment, with its audio", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-angle-render-"));
  try {
    // Red for the setup, blue for the conclusion, one continuous tone underneath.
    const input = path.join(directory, "moment.mp4"), output = path.join(directory, "conclusion-first.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=3", "-f", "lavfi", "-i", "color=blue:s=160x90:r=10:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", input], { timeout: 20_000 });
    const segments = [{ start: 4, end: 6 }, { start: 0, end: 6 }];
    await renderVideo({ input, output, source: await probeMedia(input), workDir: directory,
      settings: { ...DEFAULT_SETTINGS, segments }, signal: new AbortController().signal, onProgress: () => {} });
    const result = await probeMedia(output);
    assert.equal(result.hasAudio, true);
    assert.ok(Math.abs(result.duration - 8) < 0.2, `Expected 2s replay + 6s moment, got ${result.duration}s`);
    const color = async (time: number) => {
      const { stdout } = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(time), "-i", output,
        "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", timeout: 10_000 });
      return stdout[2]! > stdout[0]! ? "blue" : "red";
    };
    assert.deepEqual([await color(1), await color(3), await color(7)], ["blue", "red", "blue"],
      "The opening replays the conclusion, then the moment plays from its start to the same conclusion");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
