import { readWorkspaceFile } from "./helpers/workspace.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS } from "../shared/types.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) { assert.ok(Date.now() < deadline, message); await sleep(10); }
}

test("real render retries recover, release capacity, respect cancellation and survive shutdown", { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-retries-"));
  const originalPath = process.env.PATH;
  process.env.DATA_DIR = path.join(directory, "data");
  process.env.RENDER_CONCURRENCY = "1";
  process.env.RENDER_MAX_RETRIES = "3";
  const { stdout } = await exec("which", ["ffmpeg"]);
  const realFfmpeg = stdout.trim();
  const control = path.join(directory, "control.json");
  const attempts = path.join(directory, "attempts.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Fault injection only at the final encoder. Successful attempts use real
  // FFmpeg, saved plans, quality checks, output files and history persistence.
  await writeFile(path.join(bin, "ffmpeg"), `#!${process.execPath}
const fs = require('node:fs'), {spawn} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('-progress')) {
  const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
  const output = args.at(-1), id = require('node:path').basename(output, '.mp4');
  const attemptsPath = ${JSON.stringify(attempts)};
  const counts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));
  counts[id] = (counts[id] || 0) + 1;
  // The parent polls this file while the encoder runs. Publish only complete JSON.
  const temporary = attemptsPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(counts));
  fs.renameSync(temporary, attemptsPath);
  if (cfg.id === id && (cfg.hold || counts[id] <= cfg.failures)) {
    fs.writeFileSync(output, 'partial render');
    if (cfg.hold) { setInterval(() => {}, 1000); return; }
    process.stderr.write('Resource temporarily unavailable'); process.exit(1);
  }
}
const child = spawn(${JSON.stringify(realFfmpeg)}, args, {stdio:'inherit'});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`);
  await chmod(path.join(bin, "ffmpeg"), 0o700);
  await writeFile(control, "{}"); await writeFile(attempts, "{}");
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  const { config, paths } = await import("../server/config.js");
  config.retryDelayMs = 250;
  const { state, initStore, saveStore } = await import("../server/store.js");
  const { cancelJob, isRunning, pumpQueue, stopQueue } = await import("../server/queue.js");
  const { probeMedia } = await import("../server/engine.js");
  const { captureEditPlan } = await import("../server/plan-storage.js");
  const { createApp } = await import("../server/app.js");
  const { canRetryRender } = await import("../server/job-recovery.js");
  await initStore();
  const app = createApp().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => app.once("listening", resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const filePath = path.join(paths.uploads, "fixture.mp4");
    await exec(realFfmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=15:d=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", filePath]);
    const source: StoredSource = { id: randomUUID(), name: "fixture.mp4", ...await probeMedia(filePath), size: (await stat(filePath)).size,
      fingerprint: "retry-fixture", filePath, thumbnailPath: path.join(paths.thumbnails, "unused.jpg"), url: "", thumbnailUrl: "", createdAt: new Date().toISOString() };
    state.sources.push(source);
    const job = (): StoredJob => {
      const id = randomUUID();
      const item: StoredJob = { id, batchId: randomUUID(), sourceId: source.id, sourceName: source.name, variant: 1,
        status: "queued", progress: 0, createdAt: new Date().toISOString(), outputPath: path.join(paths.outputs, `${id}.mp4`),
        settings: { ...DEFAULT_SETTINGS, aspect: "original", resolution: "source", trimEnd: 0.8 } };
      state.jobs.push(item); return item;
    };
    const counts = async () => JSON.parse(await readFile(attempts, "utf8"));
    const fault = async (item: StoredJob, failures = 0, hold = false) => {
      // A retry may start while the parent changes the fault configuration.
      const temporary = `${control}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ id: item.id, failures, hold }));
      await rename(temporary, control);
    };
    const settled = (item: StoredJob) => !["queued", "processing"].includes(item.status) && !isRunning(item.id);

    await t.test("two failures recover with the exact saved plan; backoff releases its worker", async () => {
      const item = job();
      item.summary = { title: "Saved cut", changes: [], sourceDuration: 1, outputDuration: 0.8, transcriptAvailable: false, usedAI: false, narration: false };
      await captureEditPlan({ job: item, source, visuals: [], signal: new AbortController().signal });
      const plan = structuredClone(item.editPlan);
      await fault(item, 2); pumpQueue();
      await until(() => item.status === "queued" && item.retry?.count === 1, "First failure did not schedule a retry");
      assert.equal(isRunning(item.id), false);
      await assert.rejects(access(item.outputPath), { code: "ENOENT" });
      await assert.rejects(access(path.join(paths.work, item.id)), { code: "ENOENT" });
      const spare = job(); pumpQueue();
      assert.equal(spare.status, "processing", "A sleeping retry must not occupy the only worker");
      await until(() => settled(item) && settled(spare), "Retries never completed");
      assert.equal(item.status, "completed", item.error);
      assert.equal(item.retry?.count, 2);
      assert.equal((await counts())[item.id], 3);
      assert.equal(item.retry?.nextRetryAt, undefined);
      assert.deepEqual(item.editPlan, plan);
      assert.equal(state.history.filter(entry => entry.jobId === item.id).length, 1);
      assert.ok((await probeMedia(item.outputPath)).duration > 0);
    });

    await t.test("retry budget is finite and the Retry API grants a fresh budget", async () => {
      const item = job(); config.renderRetries = 2;
      await fault(item, 100); pumpQueue();
      await until(() => settled(item), "Retry budget never exhausted");
      assert.equal(item.status, "failed");
      assert.equal(item.retry?.stopped, "limit");
      assert.equal(item.retry?.count, 2);
      assert.equal((await counts())[item.id], 3);
      assert.match(item.error!, /temporarily unavailable/);
      await fault(item);
      const response = await fetch(`${base}/api/jobs/${item.id}/retry`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).retry, undefined);
      await until(() => settled(item), "Manual retry did not finish");
      assert.equal(item.status, "completed", item.error);
      assert.equal(item.retry, undefined);
      config.renderRetries = 3;
    });

    await t.test("Cancel during backoff persists and never starts another attempt", async () => {
      const item = job(); await fault(item, 100); pumpQueue();
      await until(() => item.status === "queued" && Boolean(item.retry), "Backoff not reached");
      const response = await fetch(`${base}/api/jobs/${item.id}/cancel`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.equal(item.cancelledByUser, true);
      assert.equal(item.retry?.nextRetryAt, undefined);
      await sleep(400); pumpQueue();
      assert.equal(item.status, "cancelled");
      assert.equal((await counts())[item.id], 1);
      const saved = JSON.parse(await readWorkspaceFile(path.join(config.dataDir, "state.json"), "utf8"));
      assert.equal(saved.jobs.find((entry: StoredJob) => entry.id === item.id).cancelledByUser, true);
    });

    await t.test("explicit cancellation stops an active encoder and manual retry clears that intent", async t => {
      const item = job();
      t.after(async () => {
        // An assertion failure must not leave the held encoder blocking later cases.
        if (!settled(item)) {
          await cancelJob(item);
          await until(() => settled(item), "Cancellation fixture cleanup did not settle");
        }
      });
      await fault(item, 0, true); pumpQueue();
      await until(async () => (await counts())[item.id] === 1, "Encoder did not start");
      await cancelJob(item); await until(() => settled(item), "Active cancel did not settle");
      assert.equal(item.status, "cancelled");
      assert.equal(item.retry, undefined);
      await fault(item);
      assert.equal((await fetch(`${base}/api/jobs/${item.id}/retry`, { method: "POST" })).status, 200);
      await until(() => settled(item), "Cancelled job did not retry");
      assert.equal(item.cancelledByUser, undefined);
      assert.equal(item.status, "completed", item.error);
    });

    await t.test("missing media and invalid inputs require a fix instead of repeated attempts", async () => {
      const item = job(); item.sourceId = "removed-source"; pumpQueue();
      await until(() => settled(item), "Missing media job did not settle");
      assert.equal(item.status, "failed");
      assert.equal(item.retry?.count, 0);
      assert.equal(item.retry?.stopped, "needs-attention");
      for (const code of ["ENOSPC", "EACCES", "ENOENT", "EISDIR"]) assert.equal(canRetryRender(Object.assign(new Error(code), { code })), false);
      assert.equal(canRetryRender(new Error("ffmpeg failed: Invalid data found when processing input")), false);
      assert.equal(canRetryRender(new Error("ffmpeg exceeded the processing time limit")), true);
      assert.equal(canRetryRender(Object.assign(new Error("Rate limited"), { status: 429 })), true);
      assert.equal(canRetryRender(Object.assign(new Error("Unauthorized"), { status: 401 })), false);
    });

    await t.test("invalid watermark areas stop before analysis or encoding without automatic retries", async () => {
      for (const auto of [false, true]) {
        const item = job();
        const watermarkRemoval = { enabled: true, mode: "fixed" as const, masks: [{ id: "too-large", start: 0, end: .8,
          strokes: [{ kind: "rect" as const, size: .04, points: [{ x: .1, y: .1 }, { x: .9, y: .9 }] }] }] };
        if (auto) item.auto = { ...DEFAULT_AUTO_OPTIONS, watermarkRemoval };
        else item.settings.watermarkRemoval = watermarkRemoval;
        pumpQueue(); await until(() => settled(item), "Invalid watermark job did not settle");
        assert.equal(item.status, "failed");
        assert.equal(item.retry?.count, 0); assert.equal(item.retry?.stopped, "needs-attention");
        assert.equal((await counts())[item.id], undefined, "The encoder must never start");
        assert.equal(item.editPlan, undefined, "Auto must not analyze an invalid selection");
        assert.equal(item.diagnostic?.code, "WATERMARK_SELECTION_TOO_LARGE");
        assert.match(item.diagnostic!.nextStep, /Watermark removal/);
        assert.doesNotMatch(item.error!, /file or request exceeds/);
      }
    });

    await t.test("backend shutdown queues interrupted work; restarting does not reset its budget or schedule", async () => {
      const item = job(); await fault(item, 0, true); pumpQueue();
      const deadline = Date.now() + 15000;
      while (!(await counts())[item.id]) { assert.ok(Date.now() < deadline); await sleep(20); }
      await stopQueue();
      assert.equal(item.status, "queued");
      assert.equal(item.retry?.cause, "restart");
      assert.equal(item.retry?.count, 1);
      assert.equal(item.cancelledByUser, undefined);
      await assert.rejects(access(item.outputPath), { code: "ENOENT" });
      const retry = structuredClone(item.retry);
      await saveStore(); await initStore();
      assert.deepEqual(state.jobs.find(entry => entry.id === item.id)?.retry, retry);
      assert.equal(state.jobs.find(entry => entry.id === item.id)?.status, "queued");
    });
  } finally {
    await stopQueue();
    await new Promise<void>(resolve => app.close(() => resolve()));
    process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});
