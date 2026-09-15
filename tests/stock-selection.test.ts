import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findStockBroll } from "../server/stock-broll.js";
import type { BrollWindow, inspectBrollWindows } from "../server/broll-motion.js";

const complete = (briefs: unknown[]) => Response.json({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ briefs }) } }],
});
const brief = (momentIndex = 1, query = "person working late laptop") => ({
  momentIndex,
  query,
  visual: "A person using a laptop in the evening",
  reason: "Illustrates continuing office work after hours",
});
const hit = (id: number, width = 720, height = 1280) => ({
  id,
  tags: "keyboard, screen",
  type: "film",
  user: `Creator ${id}`,
  duration: 8,
  pageURL: `https://pixabay.com/videos/id-${id}/`,
  videos: { medium: { url: `https://cdn.pixabay.com/video/2026/${id}.mp4`, width, height, size: 4 } },
});
const viable: BrollWindow = {
  sourceStart: 2.4,
  duration: 3.6,
  motion: 0.8,
  cropRetention: 1,
  score: 0.84,
};

test("semantic stock selection shortlists suitable moving portrait shots without forcing matches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stock-selection-"));
  const original = {
    stockKey: process.env.PIXABAY_API_KEY,
    textKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL,
    textModel: process.env.DEEPSEEK_TEXT_MODEL,
  };
  const stockKey = "private-stock-selection-provider-key";
  const textKey = "private-stock-selection-text-key";
  process.env.PIXABAY_API_KEY = stockKey;
  process.env.DEEPSEEK_API_KEY = textKey;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_TEXT_MODEL;
  const signal = new AbortController().signal;
  const moments = [
    { text: "After my shift I was still answering office emails." },
    { text: "I could not switch off after work." },
    { text: "That meant staying at my desk until late." },
  ];
  const probe = async (filePath: string) => {
    const id = (await readFile(filePath))[0]!;
    return { duration: 8, width: id === 1 ? 1280 : 720, height: id === 1 ? 720 : 1280, fps: 30, hasAudio: false };
  };
  const makeOptions = (name: string) => ({
    moments,
    workDir: directory,
    cacheDir: path.join(directory, name),
    matching: "ai" as const,
    targetAspect: 9 / 16,
    signal,
    onPhase: () => undefined,
    probe,
  });

  try {
    await t.test("meaning-based queries inspect two portrait candidates, discard a still and retain the actual selected interval", async () => {
      let textRequests = 0;
      let stockRequests = 0;
      const downloads: number[] = [];
      const inspections: number[] = [];
      const args = {
        ...makeOptions("shortlist"),
        fetcher: (async (input, init) => {
          assert.equal(init?.redirect, "error");
          const url = new URL(String(input));
          if (url.hostname === "api.deepseek.com") {
            textRequests++;
            const prompt = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
            assert.match(prompt.moments[1].context, /office emails/);
            assert.match(prompt.moments[1].context, /staying at my desk/);
            return complete([brief()]);
          }
          if (url.hostname === "pixabay.com") {
            stockRequests++;
            assert.equal(url.searchParams.get("q"), "person working late laptop");
            assert.equal(url.searchParams.get("lang"), "en");
            assert.equal(url.searchParams.get("per_page"), "6");
            // All result tags have no lexical overlap with either the idiom or
            // the semantic query. Retrieval can still offer these to vision.
            return Response.json({ hits: [hit(1, 1280, 720), hit(2), hit(3)] });
          }
          assert.equal(url.hostname, "cdn.pixabay.com");
          assert.equal(url.searchParams.has("key"), false);
          const id = Number(path.basename(url.pathname, ".mp4"));
          downloads.push(id);
          return new Response(new Uint8Array([id, 0, 0, 0]));
        }) as typeof fetch,
        inspect: async (asset: Parameters<typeof inspectBrollWindows>[0], targetAspect: number, inspectionSignal: AbortSignal) => {
          assert.equal(targetAspect, 9 / 16);
          assert.equal(inspectionSignal, signal);
          assert.equal(asset.width, 720);
          assert.equal(asset.height, 1280);
          const id = (await readFile(asset.filePath))[0]!;
          inspections.push(id);
          return id === 2 ? [] : [viable, { ...viable, sourceStart: 0, motion: 0.2, score: 0.36 }];
        },
      };
      const first = await findStockBroll(args);
      assert.deepEqual(downloads, [2, 3], "Portrait candidates rank ahead of landscape before the two-clip download limit");
      assert.deepEqual(inspections, [2, 3]);
      assert.equal(first.assets.length, 1);
      const selected = first.assets[0]!;
      assert.deepEqual(selected.selection, {
        sourceStart: 2.4,
        duration: 3.6,
        targetAspect: 9 / 16,
        motion: 0.8,
        cropRetention: 1,
        query: brief().query,
        reason: brief().reason,
      });
      assert.equal(selected.stock!.providerId, "pixabay:3");
      assert.equal(selected.stock!.rendition, hit(3).videos.medium.url);
      assert.match(selected.stock!.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(selected.stock!.licenseUrl, "https://pixabay.com/service/license-summary/");
      assert.deepEqual(selected.attribution, { provider: "Pixabay", creator: "Creator 3", url: hit(3).pageURL });
      assert.match(first.notes.join(" "), /no suitable moving shot/);
      assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".mp4")), [path.basename(selected.filePath)]);

      const second = await findStockBroll(args);
      assert.equal(textRequests, 1, "The meaning-based search plan is reused");
      assert.equal(stockRequests, 1, "Provider search results are reused");
      assert.equal(second.assets[0]!.stock!.providerId, selected.stock!.providerId);
      assert.equal(second.assets[0]!.stock!.contentHash, selected.stock!.contentHash);
      assert.notEqual(second.assets[0]!.id, selected.id, "Download IDs change while stable provider identity survives");
      for (const filename of await readdir(args.cacheDir)) {
        const cached = await readFile(path.join(args.cacheDir, filename), "utf8");
        assert.ok(!cached.includes(stockKey));
        assert.ok(!cached.includes(textKey));
        assert.ok(!cached.includes(directory));
      }
      for (const asset of [...first.assets, ...second.assets]) await rm(asset.filePath);
    });

    await t.test("three semantic searches inspect at most six candidates despite large result lists", async () => {
      let searches = 0;
      let downloads = 0;
      let inspections = 0;
      const result = await findStockBroll({
        ...makeOptions("bounded"),
        moments: Array.from({ length: 80 }, (_, index) => ({ text: `Spoken moment number ${index}` })),
        fetcher: async (input) => {
          const url = new URL(String(input));
          if (url.hostname === "api.deepseek.com") return complete([
            brief(0),
            brief(40, "forest walking trail"),
            brief(78, "train arriving station"),
          ]);
          if (url.hostname === "pixabay.com") {
            searches++;
            return Response.json({ hits: Array.from({ length: 20 }, (_, index) => hit(searches * 20 + index)) });
          }
          downloads++;
          return new Response(new Uint8Array([50, 0, 0, 0]));
        },
        inspect: async () => { inspections++; return [viable]; },
      });
      assert.equal(searches, 3);
      assert.equal(downloads, 6);
      assert.equal(inspections, 6);
      assert.equal(result.assets.length, 6, "Keep the small viable shortlist available for final visual matching");
      assert.equal(new Set(result.assets.map(asset => asset.stock!.providerId)).size, 6);
      for (const asset of result.assets) await rm(asset.filePath);
    });

    await t.test("an empty semantic plan makes no provider search or download and remains reusable", async () => {
      let textRequests = 0;
      const args = {
        ...makeOptions("no-match"),
        fetcher: (async (input) => {
          assert.equal(new URL(String(input)).hostname, "api.deepseek.com", "An AI rejection cannot fall back to keyword stock search");
          textRequests++;
          return complete([]);
        }) as typeof fetch,
        inspect: async () => assert.fail("No stock candidates means no media inspection"),
      };
      const result = await findStockBroll(args);
      assert.deepEqual(result.assets, []);
      assert.match(result.notes.join(" "), /Original footage was kept/);
      assert.deepEqual((await findStockBroll(args)).assets, []);
      assert.equal(textRequests, 1);
      assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".mp4")), []);
    });
  } finally {
    if (original.stockKey === undefined) delete process.env.PIXABAY_API_KEY;
    else process.env.PIXABAY_API_KEY = original.stockKey;
    if (original.textKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original.textKey;
    if (original.model === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = original.model;
    if (original.textModel === undefined) delete process.env.DEEPSEEK_TEXT_MODEL;
    else process.env.DEEPSEEK_TEXT_MODEL = original.textModel;
    await rm(directory, { recursive: true, force: true });
  }
});
