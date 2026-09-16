import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, type EditPlan, type ExportHistoryEntry, type Transcript } from "../shared/types.js";
import { EDITORIAL_POLICY_VERSION, type EditorialReport, type EditorialReviewer, type EditorialReviewRequest } from "../shared/editorial.js";
import type { StoredJob } from "../server/store.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean) => {
  for (let index = 0; index < 200; index++) { if (predicate()) return; await pause(5); }
  assert.fail("Expected asynchronous review state did not arrive");
};
const initialReport = (): EditorialReport => ({ status: "unavailable", checkedAt: "2026-01-01T00:00:00.000Z",
  policyVersion: EDITORIAL_POLICY_VERSION, modelVersion: null, checks: [], issues: [],
  coverage: { source: "word-timed", semantic: "unavailable", selectedWords: 8, totalSelectedWords: 8, neighboringContext: true,
    omittedChecks: ["source-visuals", "rendered-audio"], sourceVisuals: false, renderedAudio: false } });
const passingReply = (request: EditorialReviewRequest) => {
  const selected = request.excerpts.find(excerpt => excerpt.role === "selected")!;
  assert.ok(selected, "Fixture review must include saved selected speech");
  return { checks: request.checks.map(check => ({ check, verdict: "pass", explanation: "The supplied source evidence supports this saved edit.",
    evidence: [{ sourceId: selected.sourceId, start: selected.start, end: selected.end, quote: selected.quote }] })) };
};

test("saved editorial review updates evidence reports without rendering, editing, or spending a repair attempt", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "editorial-route-test-"));
  const environment = { DATA_DIR: process.env.DATA_DIR, AUTO_AI: process.env.AUTO_AI, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_TEXT_MODEL: process.env.DEEPSEEK_TEXT_MODEL, PEXELS_API_KEY: "", PIXABAY_API_KEY: process.env.PIXABAY_API_KEY };
  Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "true", DEEPSEEK_API_KEY: "editorial-route-test-key",
    DEEPSEEK_TEXT_MODEL: "editorial-route-test-model", PEXELS_API_KEY: "", PIXABAY_API_KEY: "" });
  const servers: Server[] = [];
  let mode: "pass" | "hold" | "fail" = "pass";
  const pending: { signal: AbortSignal; release: () => void }[] = [];
  let reviewCalls = 0;
  const running = new Set<string>();
  const reviewer: EditorialReviewer = async (request, signal) => {
    reviewCalls++;
    if (mode === "hold") await new Promise<void>(resolve => { pending.push({ signal, release: resolve }); });
    if (mode === "fail") throw new Error("Private provider failure /private/workspace/test-secret");
    return passingReply(request);
  };
  try {
    const { installEditorialReviewRoutes } = await import("../server/editorial-routes.js");
    const { initStore, saveStore, state } = await import("../server/store.js");
    const { config } = await import("../server/config.js");
    config.aiEnabled = true;
    await initStore();
    const serve = async (timeoutMs?: number) => {
      const app = express(); app.use(express.json());
      installEditorialReviewRoutes(app, { reviewer, isJobRunning: id => running.has(id), timeoutMs });
      const server = await new Promise<Server>(resolve => {
        const result = app.listen(0, "127.0.0.1", () => resolve(result));
      });
      servers.push(server);
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const base = await serve();
    const post = (id: string, body: unknown = {}, signal?: AbortSignal, root = base) => fetch(`${root}/api/jobs/${id}/editorial-review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const assets = { original: path.join(directory, "source.mp4"), output: path.join(directory, "export.mp4"),
      broll: path.join(directory, "retained-broll.mp4"), captions: path.join(directory, "captions.srt") };
    const transcript: Transcript = { language: "en", duration: 8, segments: [
      { start: 0.2, end: 1.7, text: "Keep the camera steady.", words: [
        { start: 0.2, end: 0.4, word: "Keep" }, { start: 0.45, end: 0.65, word: "the" },
        { start: 0.7, end: 1.1, word: "camera" }, { start: 1.2, end: 1.7, word: "steady." },
      ] },
      { start: 4.2, end: 5.7, text: "A tripod reduces movement.", words: [
        { start: 4.2, end: 4.4, word: "A" }, { start: 4.45, end: 4.85, word: "tripod" },
        { start: 4.9, end: 5.2, word: "reduces" }, { start: 5.3, end: 5.7, word: "movement." },
      ] },
    ] };
    const makeJob = (id = randomUUID()): StoredJob => {
      const sourceId = randomUUID(), mediaId = randomUUID();
      const cuts = [{ start: 0, end: 2, focalPoint: { x: 0.2, y: 0.5 } }, { start: 4, end: 6, focalPoint: { x: 0.8, y: 0.5 } }];
      const settings = { ...DEFAULT_SETTINGS, segments: cuts, aspect: "9:16" as const, resolution: "1080" as const,
        hookText: "Keep the camera steady", captionStyle: { fontSize: 26, bottomPercent: 18 }, normalizeAudio: true };
      const plan: EditPlan = { version: 1, revision: 3, sourceId, sourceDuration: 8, outputDuration: 4,
        createdAt: "2026-01-01T00:00:00.000Z", settings: structuredClone(settings), cuts: structuredClone(cuts),
        captions: [{ id: randomUUID(), start: 0.2, end: 1.7, text: "Keep the camera steady." },
          { id: randomUUID(), start: 2.2, end: 3.7, text: "A tripod reduces movement." }],
        media: [{ id: mediaId, name: "Saved stock shot", kind: "broll", duration: 4 }],
        visuals: [{ id: randomUUID(), mediaId, start: 0.5, end: 1.5, sourceStart: 1, enabled: true, locked: true }], narration: false };
      const report = initialReport();
      return { id, sourceId, sourceName: "source.mp4", batchId: "saved-batch", variant: 1, auto: { ...DEFAULT_AUTO_OPTIONS, editorialMode: "repair" },
        status: "completed", progress: 100, createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z",
        phase: "Needs review", outputPath: assets.output, captionPath: assets.captions, settings, editPlan: plan,
        planFiles: { [mediaId]: "retained-broll.mp4" }, sourceTranscript: structuredClone(transcript),
        downloadUrl: `/api/jobs/${id}/download`, editorialReport: report, editorialModeApplied: "repair",
        editorialRepair: { policyVersion: "editorial-repair-v1", modelVersion: "older-model", initialReport: structuredClone(report),
          finalReport: structuredClone(report), attempts: [{ attempt: 1, outcome: "accepted", targetCodes: ["hook-supported"],
            patch: { hookText: "Keep the camera steady" }, summary: "Aligned the headline", reason: "Source-grounded correction",
            beforeReport: structuredClone(report), afterReport: structuredClone(report) }], stopReason: "Automatic repair budget already used" },
        qualityReport: { status: "pass", checkedAt: "2026-01-01T00:01:00.000Z", scope: "full", issues: [] } };
    };
    const historyFor = (job: StoredJob): ExportHistoryEntry => ({ id: job.id, jobId: job.id, sourceId: job.sourceId,
      sourceFingerprint: "saved-source-fingerprint", sourceName: job.sourceName, title: job.settings.hookText,
      cuts: structuredClone(job.editPlan!.cuts), sourceText: "Keep the camera steady. A tripod reduces movement.", outputDuration: 4,
      createdAt: job.finishedAt!, revision: 3, stockShots: [{ identity: "library:preserved", name: "Saved stock shot", sourceStart: 1, duration: 1 }],
      publications: [{ platform: "instagram", publishedAt: "2026-01-02T00:00:00Z" }], measurements: { review: { notes: "Human review remains unchanged" } },
      editorialReport: structuredClone(job.editorialReport), editorialRepair: structuredClone(job.editorialRepair), editorialMode: "repair" });
    const seed = async (count = 1) => {
      mode = "pass"; reviewCalls = 0; pending.splice(0); running.clear();
      state.jobs = Array.from({ length: count }, () => makeJob()); state.history = state.jobs.map(historyFor);
      state.sources = []; state.attachments = []; state.broll = [];
      for (const [name, file] of Object.entries(assets)) await writeFile(file, `${name}: these existing media bytes must never be edited`);
      await saveStore();
      return state.jobs;
    };
    const immutable = (job: StoredJob) => structuredClone({ settings: job.settings, plan: job.editPlan, transcript: job.sourceTranscript,
      auto: job.auto, mode: job.editorialModeApplied, createdAt: job.createdAt, finishedAt: job.finishedAt, progress: job.progress,
      status: job.status, outputPath: job.outputPath, captionPath: job.captionPath, files: job.planFiles });

    await t.test("rechecking a retained plan updates job/history reports while keeping every edit and media byte", async () => {
      const [job] = await seed();
      const before = immutable(job!), repairBefore = structuredClone(job!.editorialRepair), historyBefore = structuredClone(state.history[0]);
      const bytes = await Promise.all(Object.values(assets).map(file => readFile(file)));
      const response = await post(job!.id);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal(result.editorialReport.status, "pass"); assert.equal(result.phase, "Ready to preview");
      assert.equal(result.revision, 3); assert.equal(reviewCalls, 1);
      assert.deepEqual(immutable(job!), before); assert.equal(state.jobs.length, 1);
      assert.equal(JSON.stringify(result).includes(directory), false);
      assert.equal("editPlan" in result, false); assert.equal("sourceTranscript" in result, false);
      assert.deepEqual(job!.editorialRepair!.attempts, repairBefore!.attempts);
      assert.deepEqual(job!.editorialRepair!.initialReport, repairBefore!.initialReport);
      assert.equal(job!.editorialRepair!.stopReason, repairBefore!.stopReason);
      assert.deepEqual(job!.editorialRepair!.finalReport, job!.editorialReport);
      assert.deepEqual(state.history[0]!.editorialReport, job!.editorialReport);
      assert.deepEqual(state.history[0]!.editorialRepair!.finalReport, job!.editorialReport);
      assert.deepEqual(state.history[0]!.publications, historyBefore!.publications);
      assert.deepEqual(state.history[0]!.measurements, historyBefore!.measurements);
      assert.deepEqual(await Promise.all(Object.values(assets).map(file => readFile(file))), bytes);
      const saved = JSON.parse(await readFile(path.join(directory, "data", "state.json"), "utf8"));
      assert.deepEqual(saved.jobs[0].editorialReport, result.editorialReport);
      assert.deepEqual(saved.history[0].editorialReport, result.editorialReport);
      assert.deepEqual(await readdir(path.join(directory, "data", "outputs")), [], "No new render artifact is created");
    });
    await t.test("review works after source media disappears and missing evidence remains explicitly unavailable", async () => {
      const [job] = await seed();
      await rm(assets.original);
      assert.equal((await post(job!.id)).status, 200);
      delete job!.sourceTranscript;
      const before = reviewCalls;
      const response = await post(job!.id);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).editorialReport.status, "unavailable");
      assert.equal(reviewCalls, before, "Missing source evidence does not invoke the reviewer");
    });
    await t.test("unknown, unsaved, non-Auto and unfinished jobs are rejected before review", async () => {
      const [job] = await seed();
      assert.equal((await post(randomUUID())).status, 404);
      assert.equal((await post(job!.id, { hookText: "A requested edit must not be applied" })).status, 400);
      const originalPlan = job!.editPlan; delete job!.editPlan;
      assert.equal((await post(job!.id)).status, 409); job!.editPlan = originalPlan;
      const originalAuto = job!.auto; delete job!.auto;
      assert.equal((await post(job!.id)).status, 409); job!.auto = originalAuto;
      for (const status of ["queued", "processing", "failed", "cancelled", "skipped"] as const) {
        job!.status = status; assert.equal((await post(job!.id)).status, 409);
      }
      job!.status = "completed"; running.add(job!.id);
      assert.equal((await post(job!.id)).status, 409); assert.equal(reviewCalls, 0);
    });
    await t.test("at most two jobs are reviewed concurrently and duplicate reviews of one job conflict", async () => {
      const jobs = await seed(3); mode = "hold";
      const first = post(jobs[0]!.id); await waitFor(() => pending.length === 1);
      assert.equal((await post(jobs[0]!.id)).status, 409);
      const second = post(jobs[1]!.id); await waitFor(() => pending.length === 2);
      assert.equal((await post(jobs[2]!.id)).status, 429);
      mode = "pass"; pending.forEach(item => item.release());
      assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200]);
      assert.equal((await post(jobs[2]!.id)).status, 200, "A finished review releases its slot");
    });
    await t.test("deletion during review leaves retained history untouched", async () => {
      const [job] = await seed(); const before = structuredClone(state.history);
      mode = "hold"; const response = post(job!.id); await waitFor(() => pending.length === 1);
      state.jobs = []; pending[0]!.release();
      assert.equal((await response).status, 409); assert.deepEqual(state.history, before);
    });
    await t.test("revision, caption, settings, transcript and running-state races discard stale findings", async () => {
      for (const mutate of [
        (job: StoredJob) => { job.editPlan!.revision++; },
        (job: StoredJob) => { job.editPlan!.captions[0]!.text = "A human corrected this caption"; },
        (job: StoredJob) => { job.settings.captionStyle!.bottomPercent = 25; },
        (job: StoredJob) => { job.sourceTranscript!.segments[0]!.text = "The source evidence changed"; },
        (job: StoredJob) => { running.add(job.id); },
      ]) {
        const [job] = await seed(); const oldReport = structuredClone(job!.editorialReport), oldHistory = structuredClone(state.history);
        mode = "hold"; const response = post(job!.id); await waitFor(() => pending.length === 1);
        mutate(job!); pending[0]!.release();
        assert.equal((await response).status, 409);
        assert.deepEqual(job!.editorialReport, oldReport); assert.deepEqual(state.history, oldHistory);
      }
    });
    await t.test("client cancellation reaches the reviewer and leaves saved reports unchanged", async () => {
      const [job] = await seed(); const before = structuredClone(job!.editorialReport);
      mode = "hold";
      const controller = new AbortController();
      const response = post(job!.id, {}, controller.signal);
      await waitFor(() => pending.length === 1); controller.abort();
      await assert.rejects(response, { name: "AbortError" });
      await waitFor(() => pending[0]!.signal.aborted);
      assert.deepEqual(job!.editorialReport, before); pending[0]!.release();
      mode = "pass";
      for (let index = 0; index < 50; index++) {
        const retried = await post(job!.id);
        if (retried.status === 200) return;
        assert.equal(retried.status, 409); await pause(5);
      }
      assert.fail("Cancelled review did not release its job slot");
    });
    await t.test("deadline abort and failed persistence retain previous reports without repair attempts", async () => {
      const [job] = await seed(); const before = structuredClone(job!.editorialReport), repair = structuredClone(job!.editorialRepair);
      const short = await serve(30); mode = "hold";
      const response = await post(job!.id, {}, undefined, short);
      assert.equal(response.status, 504); assert.ok(pending[0]!.signal.aborted);
      assert.deepEqual(job!.editorialReport, before); pending[0]!.release(); mode = "pass";
      await mkdir(path.join(directory, "data", "state.json.tmp"));
      try {
        assert.equal((await post(job!.id)).status, 503);
        assert.deepEqual(job!.editorialReport, before); assert.deepEqual(job!.editorialRepair, repair);
        assert.deepEqual(state.history[0]!.editorialReport, before);
      } finally { await rm(path.join(directory, "data", "state.json.tmp"), { recursive: true, force: true }); }
    });
    await t.test("provider failure becomes an honest saved report without exposing provider diagnostics", async () => {
      const [job] = await seed(); mode = "fail";
      const before = immutable(job!);
      const response = await post(job!.id);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(JSON.parse(body).editorialReport.status, "unavailable");
      assert.equal(body.includes("test-secret"), false); assert.equal(body.includes("/private/workspace"), false);
      assert.deepEqual(immutable(job!), before); assert.equal(job!.editorialRepair!.attempts.length, 1);
    });
  } finally {
    pending.forEach(item => item.release());
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
