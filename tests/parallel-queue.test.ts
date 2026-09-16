import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type Transcript } from "../shared/types.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(20);
  }
}
function gate(signal?: AbortSignal | null) {
  let release!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    release = () => { signal?.removeEventListener("abort", abort); resolve(); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  return { promise, release, signal };
}

// Real queue, plan persistence, FFmpeg and output checks; provider calls are
// isolated behind gates so overlap is proved without depending on render speed.
test("Auto pipelines overlap after selection, respect capacity and release provisional reservations", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-parallel-"));
  const cwd = process.cwd(), originalFetch = globalThis.fetch;
  const keys = ["DATA_DIR", "AUTO_AI", "DEEPSEEK_API_KEY", "DEEPSEEK_TEXT_MODEL", "RENDER_CONCURRENCY", "WHISPER_MODEL", "PIXABAY_API_KEY", "PEXELS_API_KEY"];
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let stop: (() => Promise<void>) | undefined;
  let holdDiscovery = true, discoveryCalls = 0;
  let discoveryGate: ReturnType<typeof gate> | undefined;
  let reviews: ReturnType<typeof gate>[] = [];
  const errors: unknown[] = [];
  const envelope = (value: unknown) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
  try {
    await mkdir(path.join(directory, ".venv", "bin"), { recursive: true });
    await mkdir(path.join(directory, "scripts"));
    const python = path.join(directory, ".venv", "bin", "python");
    await writeFile(python, `#!${process.execPath}\nif (!process.argv.includes('--check')) process.exit(1);\nprocess.stdout.write(JSON.stringify({available:true}));\n`);
    await chmod(python, 0o700);
    await writeFile(path.join(directory, "scripts", "transcribe.py"), "# Availability only; validated cached speech is used.\n");
    process.chdir(directory);
    Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "true", DEEPSEEK_API_KEY: "parallel-test-key",
      DEEPSEEK_TEXT_MODEL: "parallel-test", RENDER_CONCURRENCY: "2", WHISPER_MODEL: "parallel-test", PIXABAY_API_KEY: "", PEXELS_API_KEY: "" });
    globalThis.fetch = async (url, init) => {
      try {
        assert.equal(String(url), "https://api.deepseek.com/chat/completions");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer parallel-test-key");
        const content = JSON.parse(String(init?.body)).messages[1].content;
        // The unrelated manual export now also checks its finished pictures.
        if (Array.isArray(content)) {
          const context = JSON.parse(content[0].text);
          return envelope({ samples: context.samples.map((sample: { id: string }) => ({ id: sample.id, inspected: true, caption: null, issues: [] })) });
        }
        const input = JSON.parse(content).input;
        if (input.task?.startsWith("Find complete")) {
          discoveryCalls++;
          if (holdDiscovery) { holdDiscovery = false; discoveryGate = gate(init?.signal); await discoveryGate.promise; }
          return envelope({ ideas: input.units.map((unit: { id: number }) => ({
            firstUnit: unit.id, lastUnit: unit.id, kind: "statement", summary: `Camera tip ${unit.id}`,
            setupUnit: null, payoffUnit: unit.id, qualificationUnits: [],
          })) });
        }
        if (input.task?.startsWith("Choose one complete")) return envelope({ windowIndex: 0 });
        if (input.task?.startsWith("Write the on-screen")) return envelope({ hook: "Camera tips", callouts: [], narration: "" });
        assert.ok(Array.isArray(input.checks), "Unexpected external request");
        const review = gate(init?.signal); reviews.push(review);
        await review.promise;
        // Deliberate provider failure after the gate: exports must remain usable.
        // Editorial verdict correctness is covered by the editorial integration suite.
        return Response.json({ error: "Fixture review unavailable" }, { status: 401 });
      } catch (error) {
        if (!init?.signal?.aborted) errors.push(error);
        throw error;
      }
    };
    const { config, paths } = await import("../server/config.js");
    const { state, initStore } = await import("../server/store.js");
    const { pumpQueue, stopQueue, cancelJob, isRunning } = await import("../server/queue.js");
    const { probeMedia } = await import("../server/engine.js");
    const { footageOverlap } = await import("../server/diversity.js");
    stop = stopQueue;
    await initStore();
    const filePath = path.join(paths.uploads, "fixture.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=15:d=14",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=14", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "aac", "-shortest", filePath]);
    const sourceFor = async (singleIdea = false): Promise<StoredSource> => {
      const source: StoredSource = { id: randomUUID(), name: "fixture.mp4", size: (await stat(filePath)).size, ...await probeMedia(filePath),
        fingerprint: `fixture-${singleIdea}`, filePath, thumbnailPath: path.join(paths.thumbnails, "unused.jpg"), url: "", thumbnailUrl: "", createdAt: new Date().toISOString() };
      const texts = ["A faster shutter speed freezes motion.", "A tripod keeps the camera steady.", "Soft light reduces harsh shadows."];
      const transcript: Transcript = { language: "en", duration: source.duration,
        segments: texts.slice(0, singleIdea ? 1 : 3).map((text, index) => ({ start: 1 + 4 * index, end: 3 + 4 * index, text, words: [] })) };
      await writeFile(path.join(paths.analysis, `${source.id}.json`), JSON.stringify({ key: `v1:parallel-test:${source.size}:${source.duration}`, transcript }));
      state.sources.push(source); return source;
    };
    const makeJobs = (source: StoredSource, count: number) => {
      const batchId = randomUUID();
      return Array.from({ length: count }, (_, index): StoredJob => {
        const id = randomUUID();
        return { id, batchId, sourceId: source.id, sourceName: source.name, variant: index + 1, status: "queued", progress: 0,
          settings: { ...DEFAULT_SETTINGS }, createdAt: new Date().toISOString(), outputPath: path.join(paths.outputs, `${id}.mp4`),
          auto: { finishedReview: false, aspect: "16:9", targetDuration: 4, narration: false, captions: "keep", editorialMode: "check", visualSources: [] } };
      });
    };
    const settled = (items: StoredJob[]) => items.every(job => !["queued", "processing"].includes(job.status) && !isRunning(job.id));

    await t.test("three versions use two slots, share discovery and select distinct clips before the first export finishes", async () => {
      const source = await sourceFor(), jobs = makeJobs(source, 3);
      state.jobs.push(...jobs); pumpQueue();
      await until(() => Boolean(discoveryGate), "First source selection did not start");
      assert.deepEqual(jobs.map(job => job.status), ["processing", "queued", "queued"]);
      assert.match(jobs[1].phase!, /clip selection/);
      discoveryGate!.release();
      await until(() => reviews.length === 2, "Two same-source versions never reached editorial review together");
      assert.deepEqual(jobs.map(job => job.status), ["processing", "processing", "queued"]);
      assert.equal(discoveryCalls, 1, "The second version should reuse cached source discovery");
      assert.equal(footageOverlap(jobs[0].settings.segments!, jobs[1].settings.segments!), 0, "Selected cuts must be reserved before the next version plans");
      assert.match(jobs[2].phase!, /processing slot/);
      await cancelJob(jobs[0]);
      await until(() => jobs[0].status === "cancelled" && reviews.length === 3, "Cancelling one worker did not admit the next version");
      assert.equal(jobs[1].status, "processing");
      assert.equal(reviews[1].signal?.aborted, false, "A sibling cancellation must not cancel another request");
      assert.equal(footageOverlap(jobs[1].settings.segments!, jobs[2].settings.segments!), 0);
      reviews[1].release(); reviews[2].release();
      await until(() => settled(jobs), "Parallel exports did not settle");
      assert.deepEqual(jobs.map(job => job.status), ["cancelled", "completed", "completed"], JSON.stringify(jobs.map(job => job.error)));
      for (const job of jobs.slice(1)) {
        const media = await probeMedia(job.outputPath);
        assert.ok(media.hasAudio); assert.ok(media.duration > 2 && media.duration <= 4);
        assert.ok(job.downloadUrl); assert.ok(job.editPlan);
      }
      assert.equal(state.history.length, 2);
    });

    await t.test("an exhausted provisional selection waits without occupying a worker and recovers when its owner fails", async () => {
      reviews = [];
      const source = await sourceFor(true), jobs = makeJobs(source, 2);
      state.jobs.push(...jobs); pumpQueue();
      await until(() => reviews.length === 1 && jobs[1].status === "queued" && /before choosing unused/.test(jobs[1].phase || ""), "The reserved-only version was skipped or stalled instead of waiting");
      assert.equal(isRunning(jobs[1].id), false);
      const spare = makeJobs(source, 1)[0];
      delete spare.auto; spare.settings = { ...DEFAULT_SETTINGS, trimEnd: 1 };
      state.jobs.push(spare); pumpQueue();
      await until(() => settled([spare]), "A waiting version blocked an unrelated ready export");
      assert.equal(spare.status, "completed", spare.error);
      // A directory cannot be an MP4 destination: fail only this export after its review.
      await mkdir(jobs[0].outputPath);
      reviews[0].release();
      await until(() => jobs[0].status === "failed" && reviews.length === 2, "Failed reservations were not released for a new selection");
      assert.equal(jobs[1].status, "processing");
      reviews[1].release();
      await until(() => settled(jobs), "The version behind a failed reservation did not finish");
      assert.equal(jobs[1].status, "completed", jobs[1].error);
      assert.equal(state.history.some(entry => entry.jobId === jobs[0].id), false);
    });

    await t.test("the configured single-worker limit still runs one version at a time", async () => {
      config.concurrency = 1; reviews = [];
      const source = await sourceFor(), jobs = makeJobs(source, 2);
      state.jobs.push(...jobs); pumpQueue();
      await until(() => reviews.length === 1, "First single-worker review did not start");
      assert.equal(jobs[1].status, "queued");
      reviews[0].release();
      await until(() => jobs[0].status === "completed" && reviews.length === 2, "The next worker did not start after completion");
      reviews[1].release();
      await until(() => settled(jobs), "Single-worker jobs did not finish");
      assert.ok(jobs.every(job => job.status === "completed"));
    });
    assert.deepEqual(errors, []);
  } finally {
    discoveryGate?.release(); reviews.forEach(review => review.release());
    await stop?.(); globalThis.fetch = originalFetch; process.chdir(cwd);
    for (const key of keys) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
