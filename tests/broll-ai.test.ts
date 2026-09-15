import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brollAIConfigured, matchBrollWithAI } from "../server/broll-ai.js";
import { runLocal } from "../server/auto-process.js";
import { paths } from "../server/config.js";
import type { StoredBroll } from "../server/store.js";

const success = (content: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(content) },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const description = {
  description: "Green trees and dense woodland viewed outdoors.",
  usable: true,
  confidence: 0.96,
};
const moments = [
  {
    start: 5,
    end: 8,
    text: "A stroll through the forest can clear your mind.",
  },
];
type Body = {
  model: string;
  messages: { role: string; content: any }[];
  max_tokens: number;
  thinking: unknown;
  response_format: unknown;
};
const vision = (body: Body) => Array.isArray(body.messages[1]?.content);
const requestBody = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as Body;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// Mock only the paid provider. Frame extraction and cache files use the real
// engine, including a source whose opening differs from its analyzed window.
test(
  "AI B-roll uses observed windows, bounded cloud requests, and local validated caches",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "video-remix-broll-ai-"),
    );
    const oldAnalysis = paths.analysis;
    const oldFetch = globalThis.fetch;
    const oldKey = process.env.DEEPSEEK_API_KEY;
    const oldModel = process.env.DEEPSEEK_MODEL;
    paths.analysis = path.join(directory, "analysis");
    process.env.DEEPSEEK_API_KEY = "test-provider-key-do-not-leak";
    delete process.env.DEEPSEEK_MODEL;
    const source = path.join(directory, "arbitrary filename.mp4");
    const createAsset = async (): Promise<StoredBroll> => ({
      id: randomUUID(),
      name: "camera001.mp4",
      filePath: source,
      thumbnailPath: path.join(directory, "unused.jpg"),
      size: (await stat(source)).size,
      duration: 12,
      width: 160,
      height: 90,
      fps: 10,
      hasAudio: false,
      createdAt: new Date().toISOString(),
      thumbnailUrl: "/unused",
      url: "/unused",
      tags: [],
    });
    const options = (
      assets: StoredBroll[],
      signal = new AbortController().signal,
    ) => ({
      assets,
      moments,
      workDir: path.join(directory, "work"),
      signal,
    });
    const mockMatcher = (body: Body) => ({
      matches: [
        {
          momentIndex: 0,
          assetId: JSON.parse(body.messages[1]!.content).clips[0].assetId,
          confidence: 0.9,
          reason: "The visible woodland supports the spoken forest walk.",
        },
      ],
    });
    try {
      await runLocal("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=160x90:r=10:d=4",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=160x90:r=10:d=4",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:r=10:d=4",
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        source,
      ]);
      await t.test(
        "synonyms match visible content and exported start uses the analyzed window, not the opening",
        async () => {
          const asset = await createAsset();
          const bodies: Body[] = [];
          globalThis.fetch = async (input, init) => {
            assert.equal(input, "https://api.deepseek.com/chat/completions");
            assert.equal(init?.redirect, "error");
            const body = requestBody(init);
            bodies.push(body);
            assert.equal(body.model, "deepseek-flash");
            assert.deepEqual(body.thinking, { type: "disabled" });
            assert.deepEqual(body.response_format, { type: "json_object" });
            assert.ok(body.max_tokens <= 1400);
            assert.ok(
              !JSON.stringify(body).includes(directory),
              "No local paths sent to provider",
            );
            if (vision(body)) {
              const images = body.messages[1]!.content.filter(
                (part: any) => part.type === "image_url",
              );
              assert.equal(images.length, 3);
              for (let i = 0; i < images.length; i++) {
                assert.equal(images[i].image_url.detail, "low");
                assert.match(
                  images[i].image_url.url,
                  /^data:image\/jpeg;base64,/,
                );
                const imagePath = path.join(directory, `check-${i}.jpg`);
                const rgbPath = path.join(directory, `check-${i}.rgb`);
                await writeFile(
                  imagePath,
                  Buffer.from(images[i].image_url.url.split(",")[1], "base64"),
                );
                await runLocal("ffmpeg", [
                  "-v",
                  "error",
                  "-y",
                  "-i",
                  imagePath,
                  "-frames:v",
                  "1",
                  "-vf",
                  "scale=1:1",
                  "-f",
                  "rawvideo",
                  "-pix_fmt",
                  "rgb24",
                  rgbPath,
                ]);
                const pixel = await readFile(rgbPath);
                assert.ok(
                  pixel[1]! > 90 && pixel[0]! < 20 && pixel[2]! < 20,
                  "All sampled frames must be green midpoint frames, not blue opening or red ending",
                );
              }
              return success(description);
            }
            const prompt = JSON.parse(body.messages[1]!.content);
            assert.match(prompt.clips[0].description, /woodland/);
            assert.match(prompt.moments[0].text, /forest/);
            return success(mockMatcher(body));
          };
          const first = await matchBrollWithAI(options([asset]));
          assert.equal(first.matches.length, 1);
          assert.equal(first.matches[0]!.assetId, asset.id);
          assert.ok(Math.abs(first.matches[0]!.sourceStart - 4.2) < 0.001);
          assert.deepEqual(first.notes, []);
          const second = await matchBrollWithAI(options([asset]));
          assert.deepEqual(second.matches, first.matches);
          assert.equal(
            bodies.filter(vision).length,
            1,
            "Only matching repeats; image description is cached",
          );
          assert.equal(bodies.filter((body) => !vision(body)).length, 2);
          const cache = JSON.parse(
            await readFile(
              path.join(paths.analysis, `broll-${asset.id}.json`),
              "utf8",
            ),
          );
          assert.deepEqual(cache.description, description);
          assert.ok(!JSON.stringify(cache).includes("test-provider-key"));
          assert.ok(!JSON.stringify(cache).includes("data:image"));
          assert.deepEqual(
            (await readdir(paths.analysis)).filter((name) =>
              name.startsWith(".broll-frames"),
            ),
            [],
          );
          process.env.DEEPSEEK_MODEL = "deepseek-new-test-model";
          globalThis.fetch = async (_input, init) => {
            const body = requestBody(init);
            bodies.push(body);
            assert.equal(body.model, "deepseek-new-test-model");
            return success(vision(body) ? description : mockMatcher(body));
          };
          await matchBrollWithAI(options([asset]));
          assert.equal(
            bodies.filter(vision).length,
            2,
            "A model change invalidates the description cache",
          );
          delete process.env.DEEPSEEK_MODEL;
        },
      );

      await t.test(
        "stock descriptions survive new download IDs and mtimes but changed windows, crops, and content are reinspected",
        async () => {
          const asset: StoredBroll = {
            ...await createAsset(),
            selection: {
              sourceStart: 0.2,
              duration: 3.6,
              targetAspect: 9 / 16,
              motion: 0.8,
              cropRetention: 0.3164,
            },
            stock: {
              providerId: "pixabay:cached-stock-1",
              rendition: "medium",
              contentHash: createHash("sha256").update(await readFile(source)).digest("hex"),
              retrievedAt: "2026-09-01T00:00:00Z",
              licenseUrl: "https://pixabay.com/service/license-summary/",
            },
          };
          let visionCalls = 0;
          globalThis.fetch = async (_input, init) => {
            const body = requestBody(init);
            assert.ok(!JSON.stringify(body).includes(directory), "No local paths sent to provider");
            if (vision(body)) {
              visionCalls++;
              return success(description);
            }
            return success(mockMatcher(body));
          };
          const first = await matchBrollWithAI(options([asset]));
          assert.equal(first.matches[0]?.assetId, asset.id);
          assert.equal(first.matches[0]?.sourceStart, 0.2);
          assert.equal(visionCalls, 1);

          const downloadedAgain = path.join(directory, "new download.mp4");
          await copyFile(source, downloadedAgain);
          const originalMtime = (await stat(source)).mtimeMs;
          await utimes(downloadedAgain, new Date(), new Date(originalMtime + 60_000));
          assert.notEqual((await stat(downloadedAgain)).mtimeMs, originalMtime);
          const next: StoredBroll = {
            ...asset,
            id: randomUUID(),
            name: "another-download.mp4",
            filePath: downloadedAgain,
            stock: { ...asset.stock!, retrievedAt: "2026-09-02T00:00:00Z" },
          };
          const reused = await matchBrollWithAI(options([next]));
          assert.equal(visionCalls, 1, "Same stock bytes, rendition, and window reuse the paid description");
          assert.equal(reused.matches[0]?.assetId, next.id, "Cached observations bind to the current asset ID");
          assert.equal(reused.matches[0]?.sourceStart, 0.2);

          for (const [label, changed] of [
            ["interval start", { ...next, selection: { ...next.selection!, sourceStart: 4.2 } }],
            ["interval duration", { ...next, selection: { ...next.selection!, duration: 2.4 } }],
            ["crop", { ...next, selection: { ...next.selection!, targetAspect: 1 } }],
            ["content hash", { ...next, stock: { ...next.stock!, contentHash: "f".repeat(64) } }],
            ["rendition", { ...next, stock: { ...next.stock!, rendition: "large" } }],
          ] as const) {
            const before = visionCalls;
            const result = await matchBrollWithAI(options([changed]));
            assert.equal(result.matches.length, 1, label);
            assert.equal(visionCalls, before + 1, `Changed ${label} must inspect new frames`);
            assert.ok(!JSON.stringify(result).includes(directory));
          }
          const caches = (await readdir(paths.analysis)).filter((name) => name.startsWith("broll-stock-"));
          assert.equal(caches.length, 6, "One stable cache entry for each distinct inspected stock window");
          for (const filename of caches) {
            const cached = await readFile(path.join(paths.analysis, filename), "utf8");
            assert.ok(!cached.includes(directory));
            assert.ok(!cached.includes("test-provider-key"));
            assert.ok(!cached.includes("data:image"));
          }
        },
      );

      await t.test(
        "stock vision sees the selected interval and centered portrait crop rather than the source midpoint or side content",
        async () => {
          const filePath = path.join(directory, "stock with side borders.mp4");
          await runLocal("ffmpeg", [
            "-v", "error", "-y", "-i", source,
            "-vf", "drawbox=x=0:y=0:w=50:h=90:color=yellow:t=fill,drawbox=x=110:y=0:w=50:h=90:color=yellow:t=fill",
            "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", filePath,
          ]);
          const asset: StoredBroll = {
            ...await createAsset(), filePath, size: (await stat(filePath)).size,
            selection: {
              sourceStart: 0.2, duration: 3.6, targetAspect: 9 / 16,
              motion: 0.8, cropRetention: 0.3164,
            },
            stock: {
              providerId: "pixabay:framed-stock-2", rendition: "medium",
              contentHash: createHash("sha256").update(await readFile(filePath)).digest("hex"),
              retrievedAt: "2026-09-01T00:00:00Z",
              licenseUrl: "https://pixabay.com/service/license-summary/",
            },
          };
          let checkedImages = 0;
          globalThis.fetch = async (_input, init) => {
            const body = requestBody(init);
            assert.ok(!JSON.stringify(body).includes(directory));
            if (!vision(body)) return success(mockMatcher(body));
            const images = body.messages[1]!.content.filter((part: any) => part.type === "image_url");
            assert.equal(images.length, 3);
            for (const [index, image] of images.entries()) {
              const imagePath = path.join(directory, `stock-check-${index}.jpg`);
              const rgbPath = path.join(directory, `stock-check-${index}.rgb`);
              await writeFile(imagePath, Buffer.from(image.image_url.url.split(",")[1], "base64"));
              const probe = await runLocal("ffprobe", [
                "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                "-of", "json", imagePath,
              ]);
              const dimensions = JSON.parse(probe.stdout).streams[0];
              assert.ok(Math.abs(dimensions.width / dimensions.height - 9 / 16) < 0.015);
              await runLocal("ffmpeg", [
                "-v", "error", "-y", "-i", imagePath,
                "-frames:v", "1", "-vf", "scale=1:1",
                "-f", "rawvideo", "-pix_fmt", "rgb24", rgbPath,
              ]);
              const pixel = await readFile(rgbPath);
              assert.ok(
                pixel[2]! > 200 && pixel[0]! < 20 && pixel[1]! < 20,
                "Every inspected frame must show the blue selected opening; yellow sides and green midpoint are excluded",
              );
              checkedImages++;
            }
            return success(description);
          };
          const result = await matchBrollWithAI(options([asset]));
          assert.equal(checkedImages, 3);
          assert.equal(result.matches[0]?.sourceStart, 0.2);
          assert.equal(result.matches[0]?.assetId, asset.id);
          assert.ok(!JSON.stringify(result).includes(directory));
        },
      );

      await t.test(
        "long transcripts expose late spoken ideas within the request budget and preserve their original indices",
        async () => {
          const asset = await createAsset();
          const longMoments = Array.from({ length: 80 }, (_, index) => ({
            start: index * 4,
            end: index * 4 + 3,
            text: index === 60 ? "A forest walk can clear your mind." : `Other spoken idea ${index}.`,
          }));
          let sentMoments: { momentIndex: number; text: string }[] = [];
          globalThis.fetch = async (_input, init) => {
            const body = requestBody(init);
            if (vision(body)) return success(description);
            const prompt = JSON.parse(body.messages[1]!.content);
            sentMoments = prompt.moments;
            return success({
              matches: [
                {
                  momentIndex: 61,
                  assetId: asset.id,
                  confidence: 0.95,
                  reason: "This unsampled moment must not be accepted.",
                },
                {
                  momentIndex: 60,
                  assetId: asset.id,
                  confidence: 0.95,
                  reason: "The woodland supports the late forest walk idea.",
                },
              ],
            });
          };
          const result = await matchBrollWithAI({ ...options([asset]), moments: longMoments });
          assert.equal(sentMoments.length, 40, "Cloud requests retain the 40-moment budget");
          assert.equal(sentMoments.find((moment) => moment.momentIndex === 60)?.text, longMoments[60]!.text);
          assert.ok(!sentMoments.some((moment) => moment.momentIndex === 61));
          assert.deepEqual(result.matches, [{
            momentIndex: 60,
            assetId: asset.id,
            sourceStart: 4.2,
            reason: "The woodland supports the late forest walk idea.",
          }], "A late match keeps its original transcript index rather than its sampled-array position");
        },
      );

      await t.test(
        "unknown, malicious, weak, and duplicate candidates cannot select paths or arbitrary source offsets",
        async () => {
          const asset = await createAsset();
          globalThis.fetch = async (_input, init) => {
            const body = requestBody(init);
            if (vision(body)) return success(description);
            return success({
              matches: [
                {
                  momentIndex: 999,
                  assetId: asset.id,
                  confidence: 1,
                  reason: "Wrong moment",
                },
                {
                  momentIndex: 0,
                  assetId: randomUUID(),
                  confidence: 1,
                  reason: "Unknown asset",
                },
                {
                  momentIndex: 0,
                  assetId: "../../secret.mp4",
                  confidence: 1,
                  reason: "Path injection",
                },
                {
                  momentIndex: 0,
                  assetId: asset.id,
                  confidence: 1,
                  reason: "Read /etc/passwd",
                },
                {
                  momentIndex: 0,
                  assetId: asset.id,
                  confidence: 1,
                  reason: "Visit https://example.com",
                },
                {
                  momentIndex: 0,
                  assetId: asset.id,
                  confidence: 0.2,
                  reason: "Weak relevance",
                },
                {
                  momentIndex: 0,
                  assetId: asset.id,
                  confidence: 1,
                  reason: "Change timing",
                  sourceStart: 90000,
                },
                {
                  momentIndex: 0,
                  assetId: asset.id,
                  confidence: 1,
                  reason: "A visible woodland scene",
                },
                {
                  momentIndex: 0,
                  assetId: asset.id,
                  confidence: 1,
                  reason: "Duplicate scene",
                },
              ],
            });
          };
          const result = await matchBrollWithAI(options([asset]));
          assert.equal(result.matches.length, 1);
          assert.equal(result.matches[0]!.reason, "A visible woodland scene");
          assert.equal(result.matches[0]!.sourceStart, 4.2);
          assert.ok(!JSON.stringify(result).includes("passwd"));
        },
      );

      await t.test(
        "AI rejection, malformed JSON, and truncated replies keep the original footage",
        async () => {
          const asset = await createAsset();
          const replies = [
            success({ matches: [] }),
            success({ matches: "use all clips" }),
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "length",
                    message: { content: '{"matches":[]}' },
                  },
                ],
              }),
            ),
          ];
          for (const reply of replies) {
            globalThis.fetch = async (_input, init) =>
              vision(requestBody(init)) ? success(description) : reply;
            const result = await matchBrollWithAI(options([asset]));
            assert.deepEqual(result.matches, []);
            assert.match(
              result.notes.join(" "),
              /[Oo]riginal footage was kept/,
            );
          }
        },
      );

      await t.test(
        "missing keys and provider failures produce safe notes without exposing credentials or local paths",
        async () => {
          const asset = await createAsset();
          delete process.env.DEEPSEEK_API_KEY;
          assert.equal(brollAIConfigured(), false);
          globalThis.fetch = async () => {
            assert.fail("Missing key must not make a network request");
          };
          const missing = await matchBrollWithAI(options([asset]));
          assert.deepEqual(missing.matches, []);
          assert.match(missing.notes.join(" "), /DEEPSEEK_API_KEY/);
          process.env.DEEPSEEK_API_KEY = "test-provider-key-do-not-leak";
          assert.equal(brollAIConfigured(), true);
          globalThis.fetch = async () => {
            throw new Error(
              `private ${process.env.DEEPSEEK_API_KEY} ${asset.filePath}`,
            );
          };
          const failed = await matchBrollWithAI(options([asset]));
          assert.deepEqual(failed.matches, []);
          assert.match(failed.notes.join(" "), /configuration or connection/);
          assert.ok(!JSON.stringify(failed).includes("test-provider-key"));
          assert.ok(!JSON.stringify(failed).includes(directory));
          globalThis.fetch = async () =>
            new Response("provider-specific private error", { status: 401 });
          const denied = await matchBrollWithAI(options([asset]));
          assert.deepEqual(denied.matches, []);
          assert.ok(!JSON.stringify(denied).includes("provider-specific"));
        },
      );

      await t.test(
        "simultaneous edits share paid visual analysis while one cancelled consumer leaves the other running",
        async () => {
          const asset = await createAsset();
          let visionCalls = 0;
          let release: (() => void) | undefined;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          globalThis.fetch = async (_input, init) => {
            const body = requestBody(init);
            if (!vision(body)) return success(mockMatcher(body));
            visionCalls++;
            await gate;
            assert.equal(
              init?.signal?.aborted,
              false,
              "Remaining consumer keeps the shared provider request alive",
            );
            return success(description);
          };
          const firstController = new AbortController();
          const first = matchBrollWithAI(
            options([asset], firstController.signal),
          );
          const firstRejected = assert.rejects(first, { name: "AbortError" });
          const second = matchBrollWithAI(options([asset]));
          while (!visionCalls) await tick();
          await tick();
          firstController.abort();
          await firstRejected;
          release!();
          assert.equal((await second).matches.length, 1);
          assert.equal(visionCalls, 1);
        },
      );

      await t.test(
        "cancelling a running provider request propagates cancellation and cleans frame files",
        async () => {
          const asset = await createAsset();
          const controller = new AbortController();
          let entered = false;
          globalThis.fetch = async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              entered = true;
              const abort = () =>
                reject(
                  new DOMException("Provider request aborted", "AbortError"),
                );
              init?.signal?.addEventListener("abort", abort, { once: true });
              if (init?.signal?.aborted) abort();
            });
          const operation = matchBrollWithAI(
            options([asset], controller.signal),
          );
          const rejected = assert.rejects(operation, { name: "AbortError" });
          while (!entered) await tick();
          controller.abort();
          await rejected;
          assert.deepEqual(
            (await readdir(paths.analysis)).filter((name) =>
              name.startsWith(".broll-frames"),
            ),
            [],
            "Cancellation waits for shared frame cleanup when no other consumer remains",
          );
          await assert.rejects(
            stat(path.join(paths.analysis, `broll-${asset.id}.json`)),
            { code: "ENOENT" },
          );
          const alreadyCancelled = new AbortController();
          alreadyCancelled.abort();
          await assert.rejects(
            matchBrollWithAI(options([asset], alreadyCancelled.signal)),
            { name: "AbortError" },
          );
        },
      );

      await t.test(
        "analysis is capped at 20 selected assets and a visible note explains the limit",
        async () => {
          const assets = await Promise.all(
            Array.from({ length: 21 }, () => createAsset()),
          );
          let count = 0;
          globalThis.fetch = async (_input, init) => {
            assert.ok(vision(requestBody(init)));
            count++;
            return success({ ...description, usable: false });
          };
          const result = await matchBrollWithAI(options(assets));
          assert.equal(count, 20);
          assert.deepEqual(result.matches, []);
          assert.match(result.notes.join(" "), /first 20 selected/);
          await assert.rejects(
            stat(path.join(paths.analysis, `broll-${assets[20]!.id}.json`)),
            { code: "ENOENT" },
          );
        },
      );
    } finally {
      paths.analysis = oldAnalysis;
      globalThis.fetch = oldFetch;
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
      if (oldModel === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = oldModel;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
