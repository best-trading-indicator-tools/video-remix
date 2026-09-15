import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import { geometry, renderVideo } from "./engine.js";
import { AutoSkipError, prepareAutoRemix, protectFinalAutoCaptions } from "./auto.js";
import { prepareSupportingVisuals } from "./supporting-plan.js";
import type { SupportingVisual } from "./visuals.js";
import { saveStore, state, type StoredJob, type StoredSource } from "./store.js";
import { captureEditPlan, refreshPlanBroll, renderInputsFromPlan, transcriptFromPlan, preservedVisualsOnStockRefresh } from "./plan-storage.js";
import { DEFAULT_BROLL_COUNT } from "../shared/types.js";
import { getVisualSources, VISUAL_SOURCE_LABELS } from "../shared/visual-sources.js";
import { fingerprintFile, historyEntry, previousEditorialPlans, upsertHistory } from "./history.js";
import { historyThumbnailPath, retainHistoryThumbnail, type HistoryThumbnail } from "./history-thumbnails.js";
import { assertLinkedSourceUnchanged } from "./media-imports.js";
import { inspectExport } from "./quality.js";
import { reviewEditorialPlan } from "./editorial-review.js";
import { repairEditorialPlan } from "./editorial-repair.js";
import { textLayoutIssues } from "../shared/framing.js";
import { parseCaptionCues } from "./edit-plan.js";
import { readFile } from "node:fs/promises";
const running = new Map<string, AbortController>();
let stopped = false;
export const isActive = (job: StoredJob) =>
  job.status === "queued" || job.status === "processing";
export const isRunning = (jobId: string) => running.has(jobId);
/** An unidentified legacy source may be a reimport of any running Auto source. */
export function autoSourceBusy(
  job: Pick<StoredJob, "id" | "sourceId" | "auto">,
  jobs: Pick<StoredJob, "id" | "sourceId" | "auto" | "status">[],
  sources: Pick<StoredSource, "id" | "fingerprint">[],
): boolean {
  if (!job.auto) return false;
  const fingerprints = new Map(sources.map(source => [source.id, source.fingerprint]));
  const fingerprint = fingerprints.get(job.sourceId);
  return jobs.some(other => {
    if (other.id === job.id || other.status !== "processing" || !other.auto) return false;
    const otherFingerprint = fingerprints.get(other.sourceId);
    return other.sourceId === job.sourceId || !fingerprint || !otherFingerprint || fingerprint === otherFingerprint;
  });
}
export function pumpQueue() {
  if (stopped) return;
  while (running.size < config.concurrency) {
    const job = state.jobs.find(
      (item) =>
        item.status === "queued" &&
        !running.has(item.id) &&
        !autoSourceBusy(item, state.jobs, state.sources),
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
  let status: "completed" | "failed" | "cancelled" | "skipped" = "failed";
  let errorMessage: string | undefined;
  let outputSize: number | undefined;
  let thumbnail: HistoryThumbnail | undefined;
  const savedRepair = job.editorialRepair;
  delete job.qualityReport;
  delete job.editorialReport;
  // Keep the saved correction history through failed retries; its budget belongs to this job.
  delete job.editorialModeApplied;
  try {
    await saveStore();
    const source = state.sources.find((item) => item.id === job.sourceId);
    if (!source)
      throw new Error(
        "The source video is no longer available. Upload it again.",
      );
    await assertLinkedSourceUnchanged(source);
    if (!source.fingerprint) {
      source.fingerprint = await fingerprintFile(source.filePath, controller.signal);
      // Known, different sources may now use the remaining worker slots.
      pumpQueue();
    }
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
    let supportingVisuals: SupportingVisual[] = [];
    if (job.editPlan) {
      if (job.refreshBroll) {
        job.settings = structuredClone(job.editPlan.settings);
        const occupied = preservedVisualsOnStockRefresh(job.editPlan).filter(item => item.enabled);
        const options = job.auto;
        const requested = Math.max(0, (options?.brollCount ?? DEFAULT_BROLL_COUNT) - occupied.length);
        // Reuse saved graphics/library shots. Only the remaining stock slots
        // are searched, without mutating the persisted visual preferences.
        const visuals = requested ? await prepareSupportingVisuals({ source, job,
          options: { ...options!, visualSources: ["pixabay"], brollCount: requested },
          transcript: transcriptFromPlan(job), assets: [], occupied,
          workDir, signal: controller.signal, onPhase: (phase, progress) => {
            job.phase = phase; job.progress = Math.max(job.progress, progress);
          } }) : [];
        if (!requested) (job.notes ??= []).push("Saved animations and library shots already fill the shot target. Increase the target to add stock shots.");
        if (requested) await refreshPlanBroll(job, visuals, controller.signal);
        const keptShots = job.editPlan.visuals.filter(item => item.enabled);
        job.notes = (job.notes || []).filter(note => !/^(?:B-roll target:|Supporting visual target:|Visual mix —)/u.test(note));
        job.notes.push(`Supporting visual target: ${keptShots.length} of ${options?.brollCount ?? DEFAULT_BROLL_COUNT} shots added or retained.`);
        const selected = getVisualSources(options);
        if (selected.length > 1) job.notes.push(`Visual mix — ${selected.map(source => {
          const count = keptShots.filter(shot => job.editPlan!.media.find(media => media.id === shot.mediaId)?.visualSource === source).length;
          return `${VISUAL_SOURCE_LABELS[source]}: ${count}`;
        }).join(" · ")}.`);
        delete job.refreshBroll;
        await saveStore();
      }
      job.phase = "Rendering your saved edit";
      const saved = await renderInputsFromPlan(job, workDir);
      audioPath = saved.audioPath;
      subtitlePath = saved.subtitlePath;
      supportingVisuals = saved.supportingVisuals;
    } else if (job.auto) {
      const prepared = await prepareAutoRemix({
        source,
        job,
        workDir,
        signal: controller.signal,
        previous: state.jobs,
        historyPlans: previousEditorialPlans(state.history, source.fingerprint),
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
      supportingVisuals = await prepareSupportingVisuals({
        source,
        job,
        transcript: prepared.transcript,
        assets: state.broll.filter((asset) =>
          job.auto?.brollIds?.includes(asset.id),
        ),
        workDir,
        signal: controller.signal,
        onPhase: (phase, progress) => {
          job.phase = phase;
          job.progress = Math.max(job.progress, progress);
        },
      });
      job.phase = "Saving editable cut and footage";
      await captureEditPlan({ job, source, visuals: supportingVisuals, audioPath, subtitlePath,
        sourceTranscript: prepared.sourceTranscript, signal: controller.signal });
      job.phase = "Rendering your edit";
      await saveStore();
    }
    if (job.editPlan && job.auto) {
      const mode = job.auto.editorialMode ?? "repair";
      job.editorialModeApplied = mode;
      if (mode !== "off") {
        job.phase = mode === "repair" && !job.parentJobId && !savedRepair
          ? "Checking the edit and trying up to two small corrections"
          : "Checking the opening, meaning, and ending";
        if (mode === "repair" && !savedRepair) {
          const reviewed = await repairEditorialPlan({ plan: job.editPlan,
            transcript: job.sourceTranscript, signal: controller.signal,
            maxDuration: job.auto.targetDuration, protectedEdit: Boolean(job.parentJobId) });
          job.editPlan = reviewed.plan;
          job.editorialReport = reviewed.report;
          job.editorialRepair = reviewed.repairLog;
        } else {
          job.editorialReport = await reviewEditorialPlan({ plan: job.editPlan,
            transcript: job.sourceTranscript, signal: controller.signal });
          // A retry rechecks the saved result; it does not grant another repair budget.
          if (savedRepair && mode === "repair") job.editorialRepair = { ...savedRepair,
            finalReport: structuredClone(job.editorialReport),
            stopReason: "The saved edit was checked again for this render. No additional automatic corrections were attempted." };
        }
      } else delete job.editorialRepair;
      // This also runs when editorial review is off or a saved plan is retried.
      // A cancelled check must never make the saved cuts appear already inspected.
      const protectedCaptions = await protectFinalAutoCaptions({ job, source, signal: controller.signal });
      if (protectedCaptions && mode !== "off") {
        job.editorialReport = await reviewEditorialPlan({ plan: job.editPlan,
          transcript: job.sourceTranscript, signal: controller.signal });
        if (job.editorialRepair) job.editorialRepair.finalReport = structuredClone(job.editorialReport);
      }
      // Rebuild every render input from the final reviewed plan. This also writes
      // retimed captions, so a verified boundary/hook fix reaches the actual MP4.
      const saved = await renderInputsFromPlan(job, workDir);
      audioPath = saved.audioPath;
      subtitlePath = saved.subtitlePath;
      supportingVisuals = saved.supportingVisuals;
      if (job.summary && job.editPlan.settings.hookText) job.summary.title = job.editPlan.settings.hookText;
      job.phase = mode === "off" ? "Rendering your saved edit" : "Rendering the reviewed edit";
      await saveStore();
    }
    await renderVideo({
      input: source.filePath,
      output: job.outputPath,
      source,
      settings: job.settings,
      audioPath,
      subtitlePath,
      supportingVisuals,
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
    await assertLinkedSourceUnchanged(source);
    job.phase = "Checking the rendered video";
    job.qualityReport = await inspectExport({ output: job.outputPath, source,
      settings: job.settings, audioPath, supportingVisuals, signal: controller.signal });
    let captions = job.editPlan?.captions || [];
    if (!job.editPlan && subtitlePath) {
      try { captions = parseCaptionCues(await readFile(subtitlePath, "utf8")); }
      catch { job.qualityReport.issues.push({ code: "caption-check", message: "Caption layout could not be checked. Review the burned captions." }); }
    }
    const outputGeometry = geometry(source, job.settings);
    job.qualityReport.issues.push(...textLayoutIssues({ settings: job.settings, captions }, outputGeometry.width / outputGeometry.height));
    if (job.qualityReport.issues.length) job.qualityReport.status = "review";
    if (job.auto && subtitlePath) {
      job.captionPath = path.join(paths.outputs, `${job.id}.srt`);
      await copyFile(subtitlePath, job.captionPath);
    }
    outputSize = (await stat(job.outputPath)).size;
    status = "completed";
  } catch (error) {
    status = controller.signal.aborted
      ? "cancelled"
      : error instanceof AutoSkipError
        ? "skipped"
        : "failed";
    if (status === "skipped") {
      job.notes = [
        error instanceof Error
          ? error.message
          : "This version was too similar to an existing edit.",
      ];
      job.progress = 100;
    }
    errorMessage =
      error instanceof Error
        ? error.message
        : "Rendering failed. Try a different export preset.";
  } finally {
    // Keep the job processing until its old files are gone. A retry must never
    // share this work directory or output path with cleanup from the prior run.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    if (status === "completed" && !controller.signal.aborted) {
      const source = state.sources.find(item => item.id === job.sourceId);
      const entry = source && historyEntry(source, { ...job, status: "completed" });
      if (entry) thumbnail = await retainHistoryThumbnail(entry, job.outputPath, controller.signal);
    }
    if (controller.signal.aborted) status = "cancelled";
    if (status !== "completed") {
      await rm(job.outputPath, { force: true }).catch(() => undefined);
      await rm(historyThumbnailPath(job.id), { force: true }).catch(() => undefined);
      if (job.captionPath)
        await rm(job.captionPath, { force: true }).catch(() => undefined);
      delete job.captionPath;
    }
    if (controller.signal.aborted) status = "cancelled";
    job.status = status;
    job.phase =
      status === "completed"
        ? job.qualityReport?.status === "review" || (job.editorialReport && job.editorialReport.status !== "pass") ? "Needs review" : "Ready to preview"
        : status === "skipped"
          ? "Skipped"
          : undefined;
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
    const source = state.sources.find(item => item.id === job.sourceId);
    const entry = source && historyEntry(source, job);
    if (entry && thumbnail) { entry.thumbnailUrl = thumbnail.url; entry.thumbnailKind = thumbnail.kind; }
    if (entry) state.history = upsertHistory(state.history, entry);
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
      rm(path.join(paths.plans, job.id), { recursive: true, force: true }),
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
