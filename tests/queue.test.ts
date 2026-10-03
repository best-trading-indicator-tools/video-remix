import { failWorkspaceWrites, readWorkspaceFile } from "./helpers/workspace.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../shared/types.js";
import { WorkspaceDatabase } from "../server/database.js";
import type {
  StoredAttachment,
  StoredJob,
  StoredSource,
} from "../server/store.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "video-remix-queue-"));
process.env.DATA_DIR = directory;
const { config, paths } = await import("../server/config.js");
const { closeStore, initStore, publicJob, saveStore, state } = await import(
  "../server/store.js"
);
const { cancelJob, cleanupExpired, isRunning, pumpQueue, stopQueue } =
  await import("../server/queue.js");
await initStore();

beforeEach(async () => {
  state.sources = [];
  state.attachments = [];
  state.jobs = [];
  await saveStore();
});
after(async () => {
  await stopQueue();
  closeStore();
  await rm(directory, { recursive: true, force: true });
});

const oldDate = () =>
  new Date(Date.now() - config.retentionMs - 60_000).toISOString();
function job(overrides: Partial<StoredJob> = {}): StoredJob {
  const id = randomUUID();
  return {
    id,
    sourceId: randomUUID(),
    sourceName: "source.mp4",
    variant: 1,
    batchId: randomUUID(),
    status: "queued",
    progress: 0,
    settings: { ...DEFAULT_SETTINGS },
    createdAt: new Date().toISOString(),
    outputPath: path.join(paths.outputs, `${id}.mp4`),
    ...overrides,
  };
}
function source(overrides: Partial<StoredSource> = {}): StoredSource {
  const id = randomUUID();
  return {
    id,
    name: "source.mp4",
    size: 1,
    duration: 1,
    width: 16,
    height: 16,
    fps: 30,
    hasAudio: false,
    createdAt: oldDate(),
    url: "",
    thumbnailUrl: "",
    filePath: path.join(paths.uploads, `${id}.mp4`),
    thumbnailPath: path.join(paths.thumbnails, `${id}.jpg`),
    ...overrides,
  };
}
function attachment(): StoredAttachment {
  const id = randomUUID();
  return {
    id,
    kind: "audio",
    name: "audio.wav",
    filePath: path.join(paths.attachments, `${id}.wav`),
    createdAt: oldDate(),
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Queue transition timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("failed runs expose retryable status only after their work and partial output are removed", async () => {
  const item = job(); // Deliberately missing source fails without launching FFmpeg.
  item.editorialReport = { status: "pass", checkedAt: oldDate(), policyVersion: "old-review", modelVersion: "old-model",
    checks: [], issues: [], coverage: { source: "word-timed", semantic: "complete", selectedWords: 1, totalSelectedWords: 1,
      neighboringContext: true, omittedChecks: [], sourceVisuals: false, renderedAudio: false } };
  const workDir = path.join(paths.work, item.id);
  await mkdir(workDir);
  await writeFile(path.join(workDir, "old-captions.srt"), "old attempt");
  await writeFile(item.outputPath, "partial output");
  state.jobs.push(item);
  pumpQueue();
  assert.equal(item.status, "processing");
  assert.equal(item.editorialReport, undefined, "A retry must clear stale editorial approval before any operation can fail");
  assert.equal(isRunning(item.id), true);
  await until(() => item.status === "failed");
  assert.equal(
    isRunning(item.id),
    false,
    "A retryable job must have released its worker",
  );
  await assert.rejects(access(workDir), { code: "ENOENT" });
  await assert.rejects(access(item.outputPath), { code: "ENOENT" });
  assert.match(item.error!, /source video is no longer available/);
});

test("cancelling a queued job persists cancellation without starting a worker", async () => {
  const item = job();
  state.jobs.push(item);
  await cancelJob(item);
  assert.equal(item.status, "cancelled");
  assert.equal(isRunning(item.id), false);
  const saved = JSON.parse(
    await readWorkspaceFile(path.join(directory, "state.json"), "utf8"),
  );
  assert.equal(saved.jobs[0].status, "cancelled");
});

test("cancelling an orphaned processing job removes its work and partial output", async () => {
  const item = job({ status: "processing" });
  state.jobs.push(item);
  const workDir = path.join(paths.work, item.id);
  await mkdir(workDir, { recursive: true });
  await writeFile(item.outputPath, "partial");
  await cancelJob(item);
  assert.equal(item.status, "cancelled");
  assert.equal(item.cancelledByUser, true);
  await assert.rejects(access(workDir), { code: "ENOENT" });
  await assert.rejects(access(item.outputPath), { code: "ENOENT" });
});

test("active cancellation saves intent before abort and waits for the worker's cleanup", async t => {
  const item = job();
  state.jobs.push(item);
  await mkdir(path.join(paths.work, item.id), { recursive: true });
  await writeFile(item.outputPath, "partial");
  let observed = false;
  const abort = AbortController.prototype.abort;
  t.mock.method(AbortController.prototype, "abort", function (this: AbortController, reason?: unknown) {
    const db = new WorkspaceDatabase(path.join(directory, "remixer.sqlite"));
    try { assert.equal((db.loadActive().jobs.find(value => value.id === item.id) as StoredJob).cancelledByUser, true); }
    finally { db.close(); }
    observed = true;
    return abort.call(this, reason);
  });
  pumpQueue();
  assert.equal(isRunning(item.id), true);
  await cancelJob(item);
  assert.equal(observed, true);
  assert.equal(item.status, "cancelled");
  assert.equal(isRunning(item.id), false);
  await assert.rejects(access(item.outputPath), { code: "ENOENT" });
});

test("a failed cancellation save is reported instead of silently cancelling the job", async () => {
  const item = job();
  state.jobs.push(item);
  await saveStore();
  await failWorkspaceWrites(directory, true);
  try {
    await assert.rejects(cancelJob(item), /fixture disk write failure/);
    assert.equal(item.status, "queued");
    assert.equal(item.cancelledByUser, undefined);
  } finally { await failWorkspaceWrites(directory, false); }
});

test("an exception inside finalization releases the worker and starts the next queued job", async () => {
  const first = job(), next = job();
  const concurrency = config.concurrency;
  config.concurrency = 1;
  let injected = false;
  const find = state.sources.find.bind(state.sources);
  Object.defineProperty(state.sources, "find", { configurable: true, value: (...args: Parameters<typeof find>) => {
    if (!injected && first.status === "failed" && isRunning(first.id)) {
      injected = true;
      throw new Error("fixture finalization failure");
    }
    return find(...args);
  } });
  try {
    state.jobs.push(first, next);
    pumpQueue();
    await until(() => next.status === "failed" && !isRunning(next.id));
    assert.equal(injected, true);
    assert.equal(isRunning(first.id), false);
  } finally { Reflect.deleteProperty(state.sources, "find"); config.concurrency = concurrency; }
});

test("cleanup claims expired records immediately and protects queued source and attachment references", async () => {
  const protectedSource = source();
  const removedSource = source();
  const freshSource = source({ createdAt: new Date().toISOString() });
  const protectedAudio = attachment();
  const removedAudio = attachment();
  const active = job({
    sourceId: protectedSource.id,
    createdAt: oldDate(),
    settings: { ...DEFAULT_SETTINGS, audioId: protectedAudio.id },
  });
  const completed = job({
    sourceId: removedSource.id,
    status: "completed",
    createdAt: oldDate(),
    finishedAt: oldDate(),
  });
  completed.captionPath = path.join(paths.outputs, `${completed.id}.srt`);
  const expiredWork = path.join(paths.work, completed.id);
  const activeWork = path.join(paths.work, active.id);
  await Promise.all([
    mkdir(path.join(expiredWork, "transcription"), { recursive: true }),
    mkdir(activeWork, { recursive: true }),
  ]);
  state.sources.push(protectedSource, removedSource, freshSource);
  state.attachments.push(protectedAudio, removedAudio);
  state.jobs.push(active, completed);
  const removedFiles = [
    removedSource.filePath,
    removedSource.thumbnailPath,
    removedAudio.filePath,
    completed.outputPath,
    completed.captionPath,
    path.join(expiredWork, "transcription", "partial.wav"),
    path.join(paths.analysis, `${removedSource.id}.json`),
  ];
  const protectedFiles = [
    protectedSource.filePath,
    protectedSource.thumbnailPath,
    protectedAudio.filePath,
    path.join(activeWork, "active-captions.srt"),
    path.join(paths.analysis, `${protectedSource.id}.json`),
  ];
  await Promise.all(
    [...removedFiles, ...protectedFiles].map((file) =>
      writeFile(file, "media"),
    ),
  );

  const cleanup = cleanupExpired();
  assert.deepEqual(
    state.jobs.map((item) => item.id),
    [active.id],
  );
  assert.deepEqual(
    state.sources.map((item) => item.id),
    [protectedSource.id, freshSource.id],
  );
  assert.deepEqual(
    state.attachments.map((item) => item.id),
    [protectedAudio.id],
  );
  await Promise.all([cleanup, cleanupExpired()]);
  for (const file of removedFiles)
    await assert.rejects(access(file), { code: "ENOENT" });
  for (const file of protectedFiles) await access(file);
  await assert.rejects(access(expiredWork), { code: "ENOENT" });
  await access(activeWork);
  const saved = JSON.parse(
    await readWorkspaceFile(path.join(directory, "state.json"), "utf8"),
  );
  assert.deepEqual(
    saved.jobs.map((item: StoredJob) => item.id),
    [active.id],
  );
  assert.deepEqual(
    saved.sources.map((item: StoredSource) => item.id),
    [protectedSource.id, freshSource.id],
  );
});

test("startup recovery removes interrupted auto-edit artifacts, preserves completed exports, and hides internal paths", async () => {
  const summary = {
    title: "A complete spoken idea",
    changes: ["Trimmed pauses", "Automatic captions"],
    sourceDuration: 45,
    outputDuration: 30,
    transcriptAvailable: true,
    usedAI: false,
    narration: false,
  };
  const interrupted = job({
    status: "processing",
    progress: 84,
    phase: "Rendering your edit",
    auto: { aspect: "9:16", targetDuration: 30, narration: false },
    summary,
    notes: ["The hook was taken from the selected speech."],
  });
  interrupted.captionPath = path.join(paths.outputs, `${interrupted.id}.srt`);
  interrupted.captionUrl = `/api/jobs/${interrupted.id}/captions`;
  interrupted.downloadUrl = `/api/jobs/${interrupted.id}/download`;
  const completed = job({
    status: "completed",
    progress: 100,
    finishedAt: new Date().toISOString(),
    summary,
  });
  completed.captionPath = path.join(paths.outputs, `${completed.id}.srt`);
  completed.captionUrl = `/api/jobs/${completed.id}/captions`;
  completed.downloadUrl = `/api/jobs/${completed.id}/download`;
  const interruptedWork = path.join(paths.work, interrupted.id);
  await mkdir(path.join(interruptedWork, "transcribe-audio"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(interrupted.outputPath, "partial video"),
    writeFile(interrupted.captionPath, "partial captions"),
    writeFile(
      path.join(interruptedWork, "transcribe-audio", "audio.wav"),
      "scratch audio",
    ),
    writeFile(
      path.join(interruptedWork, "narration.txt"),
      "unfinished narration",
    ),
    writeFile(completed.outputPath, "finished video"),
    writeFile(completed.captionPath, "finished captions"),
  ]);
  state.jobs.push(interrupted, completed);
  await saveStore();
  state.jobs = [];

  await initStore();
  const recovered = state.jobs.find((item) => item.id === interrupted.id)!;
  assert.equal(recovered.status, "queued");
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.finishedAt, undefined);
  assert.match(recovered.phase!, /automatic retry 1 of 3/i);
  assert.equal(recovered.retry?.cause, "restart");
  assert.equal(recovered.retry?.lastPhase, "Rendering your edit");
  assert.ok(recovered.retry?.nextRetryAt);
  assert.equal(recovered.captionPath, undefined);
  assert.equal(recovered.captionUrl, undefined);
  assert.equal(recovered.downloadUrl, undefined);
  assert.deepEqual(
    recovered.summary,
    summary,
    "The useful editing summary survives recovery",
  );
  assert.deepEqual(recovered.notes, interrupted.notes);
  assert.deepEqual(
    recovered.auto,
    interrupted.auto,
    "Retry still knows this was an automatic edit",
  );
  for (const file of [
    interruptedWork,
    interrupted.outputPath,
    interrupted.captionPath!,
  ])
    await assert.rejects(access(file), { code: "ENOENT" });

  const ready = state.jobs.find((item) => item.id === completed.id)!;
  assert.equal(ready.status, "completed");
  assert.equal(await readFile(ready.outputPath, "utf8"), "finished video");
  assert.equal(await readFile(ready.captionPath!, "utf8"), "finished captions");
  const publicReady = publicJob(ready);
  assert.equal("outputPath" in publicReady, false);
  assert.equal("captionPath" in publicReady, false);
  assert.equal(publicReady.captionUrl, completed.captionUrl);
  assert.deepEqual(publicReady.summary, summary);
  const saved = JSON.parse(
    await readWorkspaceFile(path.join(directory, "state.json"), "utf8"),
  );
  const savedRecovery = saved.jobs.find(
    (item: StoredJob) => item.id === interrupted.id,
  );
  assert.equal(savedRecovery.status, "queued");
  assert.deepEqual(savedRecovery.retry, recovered.retry);
  assert.equal(savedRecovery.captionPath, undefined);
  assert.equal(savedRecovery.downloadUrl, undefined);
  assert.deepEqual(savedRecovery.summary, summary);
});

test("startup preserves deliberate cancellation, delayed retries and exhausted interruption budgets", async () => {
  const cancelled = job({ status: "processing", cancelledByUser: true });
  const exhausted = job({ status: "processing", retry: { count: 3, limit: 3, cause: "failure", reason: "Temporary failure" } });
  const nextRetryAt = new Date(Date.now() + 45000).toISOString();
  const delayed = job({ retry: { count: 2, limit: 3, cause: "failure", reason: "Temporary failure", nextRetryAt } });
  const legacy = job({ status: "cancelled" });
  state.jobs.push(cancelled, exhausted, delayed, legacy);
  await saveStore();
  await initStore();
  assert.equal(state.jobs[0].status, "cancelled");
  assert.equal(state.jobs[0].retry, undefined);
  assert.equal(state.jobs[1].status, "failed");
  assert.equal(state.jobs[1].retry?.stopped, "limit");
  assert.equal(state.jobs[1].retry?.count, 3);
  assert.equal(state.jobs[2].status, "queued");
  assert.deepEqual(state.jobs[2].retry, delayed.retry);
  assert.equal(state.jobs[3].status, "cancelled");
  assert.equal(state.jobs[3].cancelledByUser, undefined);
});
