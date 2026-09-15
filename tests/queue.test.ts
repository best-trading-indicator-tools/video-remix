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
import type {
  StoredAttachment,
  StoredJob,
  StoredSource,
} from "../server/store.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "video-remix-queue-"));
process.env.DATA_DIR = directory;
const { config, paths } = await import("../server/config.js");
const { initStore, saveStore, state } = await import("../server/store.js");
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
  const workDir = path.join(paths.work, item.id);
  await mkdir(workDir);
  await writeFile(path.join(workDir, "old-captions.srt"), "old attempt");
  await writeFile(item.outputPath, "partial output");
  state.jobs.push(item);
  pumpQueue();
  assert.equal(item.status, "processing");
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
    await readFile(path.join(directory, "state.json"), "utf8"),
  );
  assert.equal(saved.jobs[0].status, "cancelled");
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
  state.sources.push(protectedSource, removedSource, freshSource);
  state.attachments.push(protectedAudio, removedAudio);
  state.jobs.push(active, completed);
  const removedFiles = [
    removedSource.filePath,
    removedSource.thumbnailPath,
    removedAudio.filePath,
    completed.outputPath,
  ];
  const protectedFiles = [
    protectedSource.filePath,
    protectedSource.thumbnailPath,
    protectedAudio.filePath,
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
  const saved = JSON.parse(
    await readFile(path.join(directory, "state.json"), "utf8"),
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
