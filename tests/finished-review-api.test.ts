import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { DEFAULT_SETTINGS, type Transcript } from "../shared/types.js";
import type { StoredJob, StoredSource } from "../server/store.js";
import type { PictureEvidence } from "../server/finished-review.js";

test("automatic finished reviews persist and HTTP rechecks update only the report without rendering or blocking downloads", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-finished-api-"));
  const cwd = process.cwd(); const oldFetch = globalThis.fetch;
  const keys = ["DATA_DIR", "AUTO_AI", "DEEPSEEK_API_KEY", "WHISPER_MODEL"];
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let stopQueue: (() => Promise<void>) | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    process.chdir(directory);
    Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "true", DEEPSEEK_API_KEY: "synthetic-test-key", WHISPER_MODEL: "unavailable-test-model" });
    const { runLocal } = await import("../server/auto-process.js");
    const { state, initStore, saveStore } = await import("../server/store.js");
    const { paths } = await import("../server/config.js");
    const { pumpQueue, stopQueue: stop, isRunning } = await import("../server/queue.js"); stopQueue = stop;
    const { probeMedia } = await import("../server/engine.js");
    const { installFinishedReviewRoutes } = await import("../server/finished-review-routes.js");
    await initStore();
    const input = path.join(directory, "source.mp4");
    await runLocal("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "4", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", input]);
    const id = randomUUID(), sourceId = randomUUID(), subtitleId = randomUUID();
    const source: StoredSource = { id: sourceId, name: "Source.mp4", size: (await readFile(input)).length, ...(await probeMedia(input)), createdAt: new Date().toISOString(),
      filePath: input, thumbnailPath: path.join(directory, "source.jpg"), thumbnailUrl: `/api/sources/${sourceId}/thumbnail`, url: `/api/sources/${sourceId}/video` };
    const subtitles = path.join(directory, "captions.srt");
    const text = "Please show the blue square on screen";
    await writeFile(subtitles, `1\n00:00:00,000 --> 00:00:04,000\n${text}\n`);
    const job: StoredJob = { id, sourceId, sourceName: source.name, batchId: randomUUID(), variant: 1, status: "queued", progress: 0,
      settings: { ...DEFAULT_SETTINGS, subtitleId }, createdAt: new Date().toISOString(), outputPath: path.join(paths.outputs, `${id}.mp4`) };
    state.sources = [source]; state.jobs = [job]; state.attachments = [{ id: subtitleId, name: "captions.srt", kind: "subtitle", filePath: subtitles, createdAt: new Date().toISOString() }];
    await saveStore();
    let providerCalls = 0;
    const pass = (samples: PictureEvidence[]) => ({ samples: samples.map(sample => ({ id: sample.id, inspected: true, caption: null, issues: [] })) });
    globalThis.fetch = async (url, options) => {
      if (String(url) !== "https://api.deepseek.com/chat/completions") return oldFetch(url, options);
      providerCalls++;
      const request = JSON.parse(String(options?.body));
      const metadata = JSON.parse(request.messages[1].content[0].text);
      assert.ok(request.messages[1].content.some((part: { type: string }) => part.type === "image_url"));
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(pass(metadata.samples)) } }] }), { status: 200 });
    };
    pumpQueue();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && (job.status === "queued" || job.status === "processing" || isRunning(id))) await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.finishedReviewReport?.status, "partial", "Missing local audio evidence remains visible without failing the render");
    assert.ok(providerCalls > 0); assert.ok(job.downloadUrl);
    assert.deepEqual(state.history[0]?.finishedReviewReport, job.finishedReviewReport);
    const before = createHash("sha256").update(await readFile(job.outputPath)).digest("hex");
    const settings = structuredClone(job.settings);
    let held: { release: () => void } | undefined;
    let waitForRelease = false;
    const app = express(); app.use(express.json());
    installFinishedReviewRoutes(app, {
      transcriber: async ({ input: rendered }) => {
        assert.equal(rendered, job.outputPath);
        const transcript: Transcript = { language: "en", duration: 4, segments: [{ start: 0, end: 4, text,
          words: text.split(" ").map((word, i, all) => ({ word, start: 4 * i / all.length, end: 4 * (i + 1) / all.length, probability: 0.99 })) }] };
        return transcript;
      },
      vision: async samples => {
        if (waitForRelease) await new Promise<void>(resolve => { held = { release: resolve }; });
        return pass(samples);
      },
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (jobId = id, body?: unknown) => oldFetch(`${base}/api/jobs/${jobId}/finished-review`, { method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    await t.test("finished report can be rechecked and persisted without mutating the export or settings", async () => {
      assert.equal((await post("unknown")).status, 404);
      assert.equal((await post(id, { settings: {} })).status, 400);
      const response = await post(); assert.equal(response.status, 200);
      const result = await response.json() as StoredJob;
      assert.equal(result.finishedReviewReport?.status, "pass");
      assert.equal(result.finishedReviewReport?.audio.captionWindowsCompared, 1);
      assert.equal(result.outputPath, undefined); assert.equal(result.sourceTranscript, undefined);
      assert.equal(state.jobs.length, 1); assert.deepEqual(job.settings, settings);
      assert.equal(createHash("sha256").update(await readFile(job.outputPath)).digest("hex"), before);
      const persisted = JSON.parse(await readFile(path.join(directory, "data", "state.json"), "utf8"));
      assert.deepEqual(persisted.history[0].finishedReviewReport, result.finishedReviewReport);
      assert.deepEqual(persisted.jobs[0].finishedReviewReport, result.finishedReviewReport);
    });
    await t.test("duplicate in-flight reviews are rejected and a removed export cannot receive stale results", async () => {
      waitForRelease = true;
      const pending = post();
      const deadline = Date.now() + 10000;
      while (!held && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(held);
      assert.equal((await post()).status, 409);
      const savedReport = structuredClone(state.history[0]!.finishedReviewReport);
      state.jobs = [];
      held.release();
      assert.equal((await pending).status, 409);
      assert.deepEqual(state.history[0]!.finishedReviewReport, savedReport);
      assert.equal(createHash("sha256").update(await readFile(job.outputPath)).digest("hex"), before);
    });
  } finally {
    await stopQueue?.();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    globalThis.fetch = oldFetch; process.chdir(cwd);
    for (const key of keys) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
