import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findStockBroll } from "../server/stock-broll.js";
import { autoBatchSchema } from "../server/schema.js";
import {
  planSupportingVisuals,
  prepareSupportingVisuals,
} from "../server/supporting-plan.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { runLocal } from "../server/auto-process.js";
import { paths } from "../server/config.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const media = {
  duration: 5,
  width: 1280,
  height: 720,
  fps: 30,
  hasAudio: false,
};
const inspectedWindow = async () => [{
  sourceStart: 0,
  duration: 3.6,
  motion: 0.6,
  cropRetention: 0.31640625,
  score: 0.54328125,
}];
const clip = (
  id = 1,
  tags = "mountain, trail",
  type = "film",
  url = `https://cdn.pixabay.com/video/2026/${id}.mp4`,
) => ({
  id,
  tags,
  type,
  user: "Test creator",
  duration: 5,
  pageURL: `https://pixabay.com/videos/id-${id}/`,
  videos: { medium: { url, width: 1280, height: 720, size: 4 } },
});

test("stock search uses existing videos, caches queries, and keeps creator credits", async () => {
  const originalKey = process.env.PIXABAY_API_KEY;
  process.env.PIXABAY_API_KEY = "private-test-key";
  const directory = await mkdtemp(path.join(os.tmpdir(), "stock-broll-"));
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(init?.redirect, "error");
    return url.hostname === "pixabay.com"
      ? Response.json({ hits: [clip()] })
      : new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-length": "4" },
        });
  };
  const options = {
    moments: [{ text: "Follow the mountain trail" }],
    workDir: directory,
    signal: new AbortController().signal,
    cacheDir: path.join(directory, "cache"),
    onPhase: () => undefined,
    fetcher,
    probe: async () => media,
    inspect: inspectedWindow,
  };
  try {
    const result = await findStockBroll(options);
    assert.equal(result.assets.length, 1);
    assert.deepEqual(result.notes, []);
    assert.equal(requests[0]!.searchParams.get("video_type"), "all");
    assert.equal(requests[0]!.searchParams.get("q"), "mountain trail");
    assert.equal(requests[0]!.searchParams.get("key"), "private-test-key");
    assert.equal(requests[1]!.searchParams.has("key"), false);
    assert.deepEqual(result.assets[0]!.attribution, {
      provider: "Pixabay",
      creator: "Test creator",
      url: "https://pixabay.com/videos/id-1/",
    });
    assert.deepEqual(
      [...(await readFile(result.assets[0]!.filePath))],
      [1, 2, 3, 4],
    );
    await findStockBroll(options);
    assert.equal(
      requests.filter((url) => url.hostname === "pixabay.com").length,
      1,
    );
    for (const filename of await readdir(options.cacheDir))
      assert.equal(
        (
          await readFile(path.join(options.cacheDir, filename), "utf8")
        ).includes("private-test-key"),
        false,
      );
    const plans = planSupportingVisuals({
      mode: "stock",
      assets: result.assets,
      sourceName: "mountain trail.mp4",
      duration: 30,
    });
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.kind, "broll");
  } finally {
    if (originalKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("stock filters unrelated, non-animation, unsafe and oversized results; skips invalid downloads", async () => {
  const originalKey = process.env.PIXABAY_API_KEY;
  process.env.PIXABAY_API_KEY = "test-key";
  const directory = await mkdtemp(path.join(os.tmpdir(), "stock-filter-"));
  try {
    for (const [name, hit, type, expectedDownloads] of [
      ["unrelated", clip(1, "pasta, kitchen"), "all", 0],
      ["film", clip(), "animation", 0],
      ["animation", clip(1, "mountain", "animation"), "animation", 1],
      ["unavailable-rendition", {
        ...clip(),
        videos: { ...clip().videos, large: { url: "", width: 0, height: 0, size: 0 } },
      }, "all", 1],
      ["malformed-rendition", {
        ...clip(),
        videos: { ...clip().videos, large: { url: null, width: "unknown", height: 0, size: 0 } },
      }, "all", 1],
      [
        "unsafe",
        clip(1, "mountain", "film", "https://127.0.0.1/video/private.mp4"),
        "all",
        0,
      ],
      [
        "spoofed",
        clip(
          1,
          "mountain",
          "film",
          "https://cdn.pixabay.com.attacker.example/video/a.mp4",
        ),
        "all",
        0,
      ],
      [
        "playlist",
        clip(1, "mountain", "film", "https://cdn.pixabay.com/video/list.m3u8"),
        "all",
        0,
      ],
      [
        "oversized",
        {
          ...clip(),
          videos: {
            medium: { ...clip().videos.medium, size: 100 * 1024 ** 2 },
          },
        },
        "all",
        0,
      ],
    ] as const) {
      let downloads = 0;
      const result = await findStockBroll({
        moments: [{ text: "mountain trail" }],
        type,
        workDir: directory,
        cacheDir: path.join(directory, name),
        signal: new AbortController().signal,
        onPhase: () => undefined,
        probe: async () => {
          throw new Error("Invalid video");
        },
        inspect: inspectedWindow,
        fetcher: async (input) => {
          if (String(input).startsWith("https://pixabay.com/api/"))
            return Response.json({ hits: [hit] });
          downloads++;
          return new Response("invalid media");
        },
      });
      assert.equal(downloads, expectedDownloads, name);
      assert.deepEqual(result.assets, [], name);
      assert.equal(
        (await readdir(directory)).some((file) => file.endsWith(".mp4")),
        false,
      );
    }
  } finally {
    if (originalKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("stock work is bounded, preserves completed matches after failure, and propagates cancellation", async () => {
  const originalKey = process.env.PIXABAY_API_KEY;
  process.env.PIXABAY_API_KEY = "test-key";
  const directory = await mkdtemp(path.join(os.tmpdir(), "stock-limits-"));
  const moments = Array.from({ length: 30 }, (_, index) => ({
    text: `mountain trail ${index + 100}`,
  }));
  try {
    let searches = 0,
      downloads = 0;
    const options = {
      moments,
      workDir: directory,
      cacheDir: path.join(directory, "cache"),
      signal: new AbortController().signal,
      onPhase: () => undefined,
      probe: async () => media,
      inspect: inspectedWindow,
      fetcher: (async (input: RequestInfo | URL) => {
        if (String(input).startsWith("https://pixabay.com/api/"))
          return Response.json({ hits: [clip(++searches)] });
        downloads++;
        return new Response("test");
      }) as typeof fetch,
    };
    const result = await findStockBroll(options);
    assert.equal(searches, 6, "Default four shots search two backup ideas as well");
    assert.equal(downloads, 6);
    assert.equal(result.assets.length, 6);
    let attempted = 0;
    const partial = await findStockBroll({
      ...options,
      cacheDir: path.join(directory, "failure"),
      fetcher: async (input) => {
        if (!String(input).startsWith("https://pixabay.com/api/"))
          return new Response("test");
        return ++attempted === 1
          ? Response.json({ hits: [clip()] })
          : new Response("limited", { status: 429 });
      },
    });
    assert.equal(partial.assets.length, 1);
    assert.equal(attempted, 2);
    assert.ok(partial.notes.length);
    const controller = new AbortController();
    await assert.rejects(
      findStockBroll({
        ...options,
        cacheDir: path.join(directory, "cancel"),
        signal: controller.signal,
        fetcher: async () => {
          controller.abort();
          throw new Error("Cancelled");
        },
      }),
      { name: "AbortError" },
    );
  } finally {
    if (originalKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("B-roll defaults off, stock requires no uploads, and missing key keeps the original edit", async () => {
  const sourceId = "e43f968f-6458-41bc-8e5b-8b1c1e069c45";
  assert.ok(
    autoBatchSchema.safeParse({
      items: [
        {
          sourceId,
          options: { supportingVisuals: "stock", stockVideoType: "all" },
        },
      ],
    }).success,
  );
  assert.equal(
    autoBatchSchema.safeParse({
      items: [
        {
          sourceId,
          options: { supportingVisuals: "stock", stockVideoType: "made-up" },
        },
      ],
    }).success,
    false,
  );
  const originalKey = process.env.PIXABAY_API_KEY;
  delete process.env.PIXABAY_API_KEY;
  try {
    const source = {
      id: sourceId,
      name: "mountain trail.mp4",
      ...media,
    } as StoredSource;
    const job = {
      settings: { ...DEFAULT_SETTINGS },
      summary: { outputDuration: 30, changes: [] },
    } as unknown as StoredJob;
    const args = {
      source,
      job,
      assets: [],
      workDir: "/unused",
      signal: new AbortController().signal,
      onPhase: () => undefined,
    };
    assert.deepEqual(await prepareSupportingVisuals(args), []);
    assert.equal(job.notes, undefined);
    job.auto = {
      aspect: "9:16",
      targetDuration: 30,
      narration: false,
      supportingVisuals: "stock",
    };
    assert.deepEqual(await prepareSupportingVisuals(args), []);
    assert.ok(job.notes?.some((note) => note.includes("PIXABAY_API_KEY")));
  } finally {
    if (originalKey !== undefined) process.env.PIXABAY_API_KEY = originalKey;
  }
});

test("stock preparation downloads a real MP4, validates its media, and attaches credits to the edited timeline", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stock-media-"));
  const originalKey = process.env.PIXABAY_API_KEY;
  const originalAnalysis = paths.analysis;
  process.env.PIXABAY_API_KEY = "test-key";
  paths.analysis = path.join(directory, "cache");
  try {
    const fixture = path.join(directory, "existing.mp4");
    await runLocal("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=4",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      fixture,
    ]);
    const bytes = await readFile(fixture);
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0]) =>
        String(input).startsWith("https://pixabay.com/api/")
          ? Response.json({ hits: [clip()] })
          : new Response(bytes),
    );
    const source = {
      name: "mountain trail.mp4",
      ...media,
      duration: 30,
    } as StoredSource;
    const job = {
      settings: { ...DEFAULT_SETTINGS },
      auto: {
        aspect: "9:16",
        targetDuration: 30,
        narration: false,
        supportingVisuals: "stock",
      },
      summary: { outputDuration: 30, changes: [] },
    } as unknown as StoredJob;
    const visuals = await prepareSupportingVisuals({
      source,
      job,
      assets: [],
      workDir: directory,
      signal: new AbortController().signal,
      onPhase: () => undefined,
      transcript: {
        language: "en",
        duration: 30,
        segments: [{ start: 8, end: 11, text: "mountain trail", words: [] }],
      },
    });
    assert.equal(visuals.length, 1);
    assert.equal(visuals[0]!.kind, "broll");
    assert.equal(visuals[0]!.start, 8);
    assert.equal(visuals[0]!.end, 11);
    assert.deepEqual(await readFile(visuals[0]!.path), bytes);
    assert.equal(job.supportingVisuals![0]!.attribution!.provider, "Pixabay");
    assert.equal(
      JSON.stringify(job.supportingVisuals).includes(directory),
      false,
    );
    assert.ok(job.summary!.changes.includes("1 B-roll cutaway"));
  } finally {
    paths.analysis = originalAnalysis;
    if (originalKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});
