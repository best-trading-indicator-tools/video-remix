import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import { renderVideo } from "./engine.js";
import { prepareAutoRemix } from "./auto.js";
import { saveStore, state, type StoredJob } from "./store.js";
const running = new Map<string, AbortController>();
let stopped = false;
export const isActive = (job: StoredJob) =>
  job.status === "queued" || job.status === "processing";
export const isRunning = (jobId: string) => running.has(jobId);
export function pumpQueue() {
  if (stopped) return;
  while (running.size < config.concurrency) {
    const job = state.jobs.find(
      (item) =>
        item.status === "queued" &&
        !running.has(item.id) &&
        (!item.auto ||
          !state.jobs.some(
            (other) =>
              other.status === "processing" &&
              other.auto &&
              other.sourceId === item.sourceId,
          )),
    );
    if (!job) break;
    const controller = new AbortController();
    running.set(job.id, controller);
    job.status = "processing";
    void run(job, controller);
  }
}
async function run(job: StoredJob, controller: AbortController) {
  const workDir = path.join(paths.work, job.id);
  let status: "completed" | "failed" | "cancelled" = "failed";
  let errorMessage: string | undefined;
  let outputSize: number | undefined;
  try {
    await saveStore();
    const source = state.sources.find((item) => item.id === job.sourceId);
    if (!source)
      throw new Error(
        "The source video is no longer available. Upload it again.",
      );
    const audio = state.attachments.find(
      (item) => item.id === job.settings.audioId,
    );
    const subtitle = state.attachments.find(
      (item) => item.id === job.settings.subtitleId,
    );
    if (job.settings.audioId && !audio)
      throw new Error(
        "Replacement audio is no longer available. Attach it again.",
      );
    if (job.settings.subtitleId && !subtitle)
      throw new Error("Subtitle file is no longer available. Attach it again.");
    await mkdir(workDir, { recursive: true });
    let audioPath = audio?.filePath;
    let subtitlePath = subtitle?.filePath;
    if (job.auto) {
      const prepared = await prepareAutoRemix({
        source,
        job,
        workDir,
        signal: controller.signal,
        onPhase: (phase, progress) => {
          job.phase = phase;
          job.progress = Math.max(job.progress, Math.round(progress));
        },
      });
      job.settings = prepared.settings;
      job.summary = prepared.summary;
      job.notes = prepared.notes;
      audioPath = prepared.audioPath;
      subtitlePath = prepared.subtitlePath;
      await saveStore();
    }
    await renderVideo({
      input: source.filePath,
      output: job.outputPath,
      source,
      settings: job.settings,
      audioPath,
      subtitlePath,
      workDir,
      signal: controller.signal,
      onProgress: (progress) => {
        job.progress = Math.max(
          job.progress,
          Math.min(99, Math.round(job.auto ? 65 + progress * 0.34 : progress)),
        );
      },
    });
    if (controller.signal.aborted) throw new Error("Cancelled");
    if (job.auto && subtitlePath) {
      job.captionPath = path.join(paths.outputs, `${job.id}.srt`);
      await copyFile(subtitlePath, job.captionPath);
    }
    outputSize = (await stat(job.outputPath)).size;
    status = "completed";
  } catch (error) {
    status = controller.signal.aborted ? "cancelled" : "failed";
    errorMessage =
      error instanceof Error
        ? error.message
        : "Rendering failed. Try a different export preset.";
  } finally {
    // Keep the job processing until its old files are gone. A retry must never
    // share this work directory or output path with cleanup from the prior run.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if (controller.signal.aborted) status = "cancelled";
    if (status !== "completed") {
      await rm(job.outputPath, { force: true }).catch(() => undefined);
      if (job.captionPath)
        await rm(job.captionPath, { force: true }).catch(() => undefined);
      delete job.captionPath;
    }
    if (controller.signal.aborted) status = "cancelled";
    job.status = status;
    job.phase = status === "completed" ? "Ready" : undefined;
    job.error = status === "failed" ? errorMessage : undefined;
    if (status === "completed") {
      job.outputSize = outputSize;
      job.progress = 100;
      job.downloadUrl = `/api/jobs/${job.id}/download`;
      if (job.captionPath) job.captionUrl = `/api/jobs/${job.id}/captions`;
    } else {
      delete job.outputSize;
      delete job.downloadUrl;
      delete job.captionUrl;
    }
    job.finishedAt = new Date().toISOString();
    running.delete(job.id);
    await saveStore().catch((error) =>
      console.error("Unable to save render result:", error),
    );
    pumpQueue();
  }
}
export async function cancelJob(job: StoredJob) {
  if (job.status === "queued") {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
  } else if (job.status === "processing") {
    running.get(job.id)?.abort();
  }
  await saveStore();
}
export async function stopQueue() {
  stopped = true;
  for (const controller of running.values()) controller.abort();
  const deadline = Date.now() + 5000;
  while (running.size && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await saveStore();
}
export async function cleanupExpired() {
  const cutoff = Date.now() - config.retentionMs;
  const expired = (date: string) => new Date(date).getTime() < cutoff;
  const jobs = state.jobs.filter(
    (job) =>
      !isActive(job) &&
      !running.has(job.id) &&
      expired(job.finishedAt || job.createdAt),
  );
  const expiredJobIds = new Set(jobs.map((job) => job.id));
  state.jobs = state.jobs.filter((job) => !expiredJobIds.has(job.id));
  const referencedSources = new Set(state.jobs.map((job) => job.sourceId));
  const referencedAttachments = new Set(
    state.jobs.flatMap((job) => [
      job.settings.audioId,
      job.settings.subtitleId,
    ]),
  );
  const sources = state.sources.filter(
    (source) => expired(source.createdAt) && !referencedSources.has(source.id),
  );
  const attachments = state.attachments.filter(
    (attachment) =>
      expired(attachment.createdAt) &&
      !referencedAttachments.has(attachment.id),
  );
  const expiredSourceIds = new Set(sources.map((source) => source.id));
  const expiredAttachmentIds = new Set(
    attachments.map((attachment) => attachment.id),
  );
  // Claim all records before yielding so a new export cannot reference a file
  // while it is being removed, and overlapping cleanup calls cannot splice -1.
  state.sources = state.sources.filter(
    (source) => !expiredSourceIds.has(source.id),
  );
  state.attachments = state.attachments.filter(
    (attachment) => !expiredAttachmentIds.has(attachment.id),
  );
  if (!jobs.length && !sources.length && !attachments.length) return;
  await saveStore();
  await Promise.all([
    ...jobs.flatMap((job) => [
      rm(job.outputPath, { force: true }),
      rm(path.join(paths.work, job.id), { recursive: true, force: true }),
      ...(job.captionPath ? [rm(job.captionPath, { force: true })] : []),
    ]),
    ...sources.flatMap((source) => [
      rm(source.filePath, { force: true }),
      rm(source.thumbnailPath, { force: true }),
      rm(path.join(paths.analysis, `${source.id}.json`), { force: true }),
    ]),
    ...attachments.map((attachment) =>
      rm(attachment.filePath, { force: true }),
    ),
  ]);
}
