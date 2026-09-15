import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  graphicHtml,
  graphicsAvailable,
  renderGraphic,
} from "../server/visuals.js";
import { probeMedia } from "../server/engine.js";

test("motion-card source text stays inert and dimensions are bounded", () => {
  const html = graphicHtml({
    text: '<script>fetch("https://example.com")</script> & facts',
    caption: "A < B",
    width: 360,
    height: 640,
    duration: 3,
  });
  assert.ok(html.includes("&lt;script&gt;fetch(&quot;"));
  assert.ok(html.includes("A &lt; B"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!/\b(?:src|href)=/.test(html), "Cards have no external assets");
  assert.throws(
    () => graphicHtml({ text: "x", width: 99999, height: 640, duration: 3 }),
    /dimensions/,
  );
  assert.throws(
    () => graphicHtml({ text: "", width: 360, height: 640, duration: 3 }),
    /title/,
  );
});

function frame(file: string, time: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=180:320",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error)),
    );
  });
}

test(
  "HyperFrames renders real moving text cards locally without audio or remote assets",
  { timeout: 190_000 },
  async (t) => {
    if (!(await graphicsAvailable())) {
      if (process.env.REQUIRE_GRAPHICS_TESTS === "true")
        assert.fail("Local HyperFrames browser must be installed");
      t.skip("Install the local HyperFrames browser to exercise the renderer");
      return;
    }
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-visuals-"),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      assert.ok(
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
        `Unexpected network dependency: ${url.hostname}`,
      );
      return originalFetch(input, init);
    };
    try {
      const output = path.join(directory, "card.mp4");
      const workDir = path.join(directory, "work");
      await renderGraphic({
        text: "The right light changes everything.",
        caption: "A simple idea, clearly explained.",
        width: 360,
        height: 640,
        duration: 1.5,
        output,
        workDir,
        signal: new AbortController().signal,
      });
      const info = await probeMedia(output);
      assert.deepEqual(
        [info.width, info.height, info.hasAudio],
        [360, 640, false],
      );
      assert.ok(Math.abs(info.duration - 1.5) < 0.06);
      assert.ok((await stat(output)).size > 5000);
      const [first, later] = await Promise.all([
        frame(output, 0.05),
        frame(output, 0.9),
      ]);
      let changed = 0;
      let white = 0;
      for (let i = 0; i < later.length; i += 3) {
        if (Math.abs(first[i]! - later[i]!) > 20) changed++;
        if (later[i]! > 180 && later[i + 1]! > 180 && later[i + 2]! > 180)
          white++;
      }
      assert.ok(
        changed > 500,
        `Motion must change visible pixels; got ${changed}`,
      );
      assert.ok(
        white > 300,
        `The title must actually be rendered; got ${white}`,
      );
      assert.deepEqual(
        await readdir(workDir),
        [],
        "Composition files are removed",
      );
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        renderGraphic({
          text: "Cancelled",
          width: 360,
          height: 640,
          duration: 1.5,
          output: path.join(directory, "cancelled.mp4"),
          workDir,
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
      await assert.rejects(stat(path.join(directory, "cancelled.mp4")), {
        code: "ENOENT",
      });
      const running = new AbortController();
      const timer = setTimeout(() => running.abort(), 750);
      try {
        await assert.rejects(
          renderGraphic({
            text: "This in-progress render should be cancelled",
            width: 720,
            height: 1280,
            duration: 8,
            output: path.join(directory, "interrupted.mp4"),
            workDir,
            signal: running.signal,
          }),
          { name: "AbortError" },
        );
        assert.deepEqual(
          await readdir(workDir),
          [],
          "Interrupted composition is removed",
        );
        await assert.rejects(stat(path.join(directory, "interrupted.mp4")), {
          code: "ENOENT",
        });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
