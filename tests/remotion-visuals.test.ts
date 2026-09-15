import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { probeMedia } from "../server/engine.js";
import {
  remotionAvailable,
  renderRemotionGraphic,
} from "../server/remotion-visuals.js";

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
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr)),
    );
  });
}

test("Remotion rejects unbounded inputs and pre-cancelled work before creating any files", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "video-remix-remotion-invalid-"),
  );
  try {
    const options = {
      text: "A useful idea",
      width: 360,
      height: 640,
      duration: 1,
      output: path.join(directory, "existing.mp4"),
      workDir: path.join(directory, "work"),
      signal: new AbortController().signal,
    };
    await writeFile(options.output, "existing export");
    for (const invalid of [
      { text: "" },
      { text: "x".repeat(181) },
      { caption: "x".repeat(161) },
      { text: "\0" },
      { width: 4098 },
      { width: 359 },
      { width: 4096, height: 4096 },
      { duration: 11 },
      { duration: NaN },
    ]) {
      await assert.rejects(
        renderRemotionGraphic({ ...options, ...invalid }),
        /title|dimensions/,
      );
    }
    await assert.rejects(
      renderRemotionGraphic({ ...options, signal: AbortSignal.abort() }),
      { name: "AbortError" },
    );
    assert.equal(await readFile(options.output, "utf8"), "existing export");
    assert.deepEqual(await readdir(directory), ["existing.mp4"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "Remotion renders moving local artwork, keeps markup inert, reuses its bundle and cleans interrupted renders",
  { timeout: 190_000 },
  async (t) => {
    if (!(await remotionAvailable())) {
      if (process.env.REQUIRE_GRAPHICS_TESTS === "true")
        assert.fail("Install the local Chrome browser to test Remotion");
      t.skip("Install the local Chrome browser to exercise the renderer");
      return;
    }
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-remotion-"),
    );
    const workDir = path.join(directory, "work");
    const existingBundles = new Set(
      (await readdir(os.tmpdir())).filter((name) =>
        name.startsWith("video-remix-remotion-bundle-"),
      ),
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
        `Unexpected remote dependency: ${url.hostname}`,
      );
      return originalFetch(input, init);
    };
    let requests = 0;
    const trap = createServer((_request, response) => {
      requests++;
      response.writeHead(200).end("unexpected request");
    });
    await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve));
    try {
      const output = path.join(directory, "idea.mp4");
      const options = {
        text: "Make one idea impossible to miss.",
        caption: "A short phrase. A clear takeaway.",
        width: 360,
        height: 640,
        duration: 1.5,
        workDir,
        output,
        signal: new AbortController().signal,
      };
      await renderRemotionGraphic(options);
      const info = await probeMedia(output);
      assert.deepEqual(
        [info.width, info.height, info.hasAudio],
        [360, 640, false],
      );
      assert.ok(Math.abs(info.duration - 1.5) < 0.05);
      assert.ok((await stat(output)).size > 5000);
      const [first, middle, last] = await Promise.all([
        frame(output, 0),
        frame(output, 0.9),
        frame(output, 1.4),
      ]);
      let entranceMotion = 0;
      let continuedMotion = 0;
      let darkTitle = 0;
      let paleBackground = 0;
      for (let index = 0; index < middle.length; index += 3) {
        if (Math.abs(first[index]! - middle[index]!) > 25) entranceMotion++;
        if (Math.abs(middle[index]! - last[index]!) > 25) continuedMotion++;
        const row = Math.floor(index / 3 / 180);
        if (
          row > 80 &&
          row < 205 &&
          middle[index]! < 100 &&
          middle[index + 1]! < 120 &&
          middle[index + 2]! < 150
        )
          darkTitle++;
        if (
          middle[index]! > 215 &&
          middle[index + 1]! > 215 &&
          middle[index + 2]! > 205
        )
          paleBackground++;
      }
      assert.ok(
        entranceMotion > 500,
        `Visible entrance animation: ${entranceMotion} changed pixels`,
      );
      assert.ok(
        continuedMotion > 100,
        `The selected interval keeps moving: ${continuedMotion} changed pixels`,
      );
      assert.ok(
        darkTitle > 500,
        `The title must be legible in its content area: ${darkTitle} dark pixels`,
      );
      assert.ok(
        paleBackground > 25000,
        "The Remotion artwork has its own light editorial design",
      );
      assert.deepEqual(await readdir(workDir), []);

      const address = trap.address();
      assert.ok(address && typeof address !== "string");
      await renderRemotionGraphic({
        ...options,
        text: `<img src="http://127.0.0.1:${address.port}/injected">`,
        caption: '<script>fetch("/injected")</script> & facts',
        duration: 0.5,
        output: path.join(directory, "inert.mp4"),
      });
      assert.equal(
        requests,
        0,
        "User text cannot create HTML nodes or network requests",
      );
      assert.equal(
        (await probeMedia(path.join(directory, "inert.mp4"))).width,
        360,
      );
      const addedBundles = (await readdir(os.tmpdir())).filter(
        (name) =>
          name.startsWith("video-remix-remotion-bundle-") &&
          !existingBundles.has(name),
      );
      assert.equal(
        addedBundles.length,
        1,
        "Consecutive cards reuse exactly one fixed development bundle",
      );

      const interrupted = path.join(directory, "interrupted.mp4");
      await writeFile(interrupted, "previous export");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 750);
      const start = Date.now();
      try {
        await assert.rejects(
          renderRemotionGraphic({
            ...options,
            width: 720,
            height: 1280,
            duration: 8,
            output: interrupted,
            signal: controller.signal,
          }),
          { name: "AbortError" },
        );
        assert.ok(
          Date.now() - start < 15_000,
          "Cancellation closes the active browser promptly",
        );
        assert.equal(
          await readFile(interrupted, "utf8"),
          "previous export",
          "Cancellation never replaces an existing export with partial bytes",
        );
        assert.deepEqual(await readdir(workDir), []);
        assert.equal(
          (await readdir(directory)).filter((name) =>
            name.startsWith(".remotion-"),
          ).length,
          0,
        );
      } finally {
        clearTimeout(timer);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => trap.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
