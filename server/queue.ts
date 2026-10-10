import { historyRecords, historyMatches } from "./store.js";
import { withJobUsage } from "./job-usage.js";
import { reviewJobFinished } from "./finished-review-jobs.js";
import { visualIdentity } from "./visual-identity.js";
import { stockProvidersForEdit } from "./stock-broll.js";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { publishingJobs } from './publishing-lock.js';
import { config, paths } from "./config.js";
import { geometry, renderVideo, probeMedia } from "./engine.js";
import { AutoSkipError, prepareAutoRemix, protectFinalAutoCaptions } from "./auto.js";
import { prepareSupportingVisuals } from "./supporting-plan.js";
import { prepareManualVisuals } from "./manual-visuals.js";
import type { SupportingVisual } from "./visuals.js";
import { saveStore, state, type StoredJob, type StoredSource } from "./store.js";
import { captureEditPlan, refreshPlanBroll, renderInputsFromPlan, transcriptFromPlan, preservedVisualsOnStockRefresh } from "./plan-storage.js";
import { DEFAULT_BROLL_COUNT, type TranscriptWord } from "../shared/types.js";
import { getVisualSources, VISUAL_SOURCE_LABELS } from "../shared/visual-sources.js";
import { fingerprintFile, historyEntry, previousEditorialPlans, upsertHistory, relatedHistory } from "./history.js";
import { historyThumbnailPath, retainHistoryThumbnail, type HistoryThumbnail } from "./history-thumbnails.js";
import { assertLinkedSourceUnchanged } from "./media-imports.js";
import { inspectExport } from "./quality.js";
import { AI_REQUEST_BUDGET_MS } from "./ai-json.js";
import type { EditorialReviewProgress } from "../shared/editorial-repair.js";
import { reviewEditorialPlan } from "./editorial-review.js";
import { repairEditorialPlan, EDITORIAL_REPAIR_BUDGET_MS } from "./editorial-repair.js";
import { textLayoutIssues } from "../shared/framing.js";
import { parseCaptionCues } from "./edit-plan.js";
import { footageContainment } from "./diversity.js";
import { readFile } from "node:fs/promises";
import { canRetryRender, recoverInterruptedJob, retryPhase, scheduleJobRetry } from "./job-recovery.js";
import { retainFootage } from "./footage-storage.js";
import { captionsAfterInserts, footageTimeline } from "../shared/own-footage.js";
import { captionCuesSrt } from "./edit-plan.js";
import { writeFile } from "node:fs/promises";
import { addManualCaptions, wantsManualCaptions } from "./manual-captions.js";
import { serverDiagnostic } from "./diagnostics.js";
import { preflightWatermarkRemoval } from "./watermark-removal.js";
import { assertUpscaleInstalled } from "./upscale.js";
const running = new Map<string, AbortController>();
const runningPromises = new Map<string, Promise<void>>();
// Only initial analysis and clip selection need exclusive access to a source.
// Once cuts are chosen, expensive stock searches, reviews and exports can overlap.
const selecting = new Set<string>();
const selected = new Set<string>();
const waitingFor = new Map<string, string[]>();
let stopped = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
export const isActive = (job: StoredJob) =>
  job.status === "queued" || job.status === "processing";
export const isRunning = (jobId: string) => running.has(jobId);
/** An unidentified legacy source may be a reimport of any running Auto source. */
export function autoSourceBusy(
  job: Pick<StoredJob, "id" | "sourceId" | "auto" | "editPlan">,
  jobs: Pick<StoredJob, "id" | "sourceId" | "auto" | "status" | "editPlan">[],
  sources: Pick<StoredSource, "id" | "fingerprint">[],
  selectingIds?: ReadonlySet<string>,
): boolean {
  if (!job.auto || job.editPlan) return false;
  const fingerprints = new Map(sources.map(source => [source.id, source.fingerprint]));
  const fingerprint = fingerprints.get(job.sourceId);
  return jobs.some(other => {
    if (other.id === job.id || other.status !== "processing" || !other.auto) return false;
    if (other.editPlan || (selectingIds && !selectingIds.has(other.id))) return false;
    const otherFingerprint = fingerprints.get(other.sourceId);
    return other.sourceId === job.sourceId || !fingerprint || !otherFingerprint || fingerprint === otherFingerprint;
  });
}
export function pumpQueue() {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  const now = Date.now();
  for (const [id, dependencies] of waitingFor) {
    if (!dependencies.some(dependency => running.has(dependency))) waitingFor.delete(id);
  }
  while (running.size < config.concurrency) {
    const job = state.jobs.find(
      (item) =>
        item.status === "queued" &&
        !item.cancelledByUser &&
        (!item.retry?.nextRetryAt || Date.parse(item.retry.nextRetryAt) <= now) &&
        !running.has(item.id) &&
        !waitingFor.has(item.id) &&
        !autoSourceBusy(item, state.jobs, state.sources, selecting),
    );
    if (!job) break;
    const controller = new AbortController();
    running.set(job.id, controller);
    if (job.auto && !job.editPlan) selecting.add(job.id);
    job.status = "processing";
    if (job.retry) delete job.retry.nextRetryAt;
    job.phase = job.retry ? `Starting automatic retry ${job.retry.count} of ${job.retry.limit}` : "Preparing your edit";
    const promise = runWithRelease(job, controller);
    runningPromises.set(job.id, promise);
  }
  for (const job of state.jobs.filter(item => item.status === "queued")) {
    job.phase = job.retry?.nextRetryAt && Date.parse(job.retry.nextRetryAt) > now ? retryPhase(job)
      : waitingFor.has(job.id) ? "Waiting for another version to finish before choosing unused footage"
      : autoSourceBusy(job, state.jobs, state.sources, selecting) ? "Waiting for another clip selection from this source"
      : "Waiting for a processing slot";
  }
  // A delayed retry holds no worker slot. One timer wakes the nearest due job;
  // retries that are already due wait for a worker to finish without busy polling.
  const next = state.jobs.filter(job => job.status === "queued" && job.retry?.nextRetryAt)
    .map(job => Date.parse(job.retry!.nextRetryAt!)).filter(time => time > now);
  if (next.length) {
    retryTimer = setTimeout(pumpQueue, Math.max(1, Math.min(...next) - Date.now()));
    retryTimer.unref();
  }
}
async function trackEditorialReview<T>(job: StoredJob, budgetMs: number,
  work: (update: (progress: EditorialReviewProgress) => void) => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  const update = (progress: EditorialReviewProgress) => {
    job.editorialProgress = { ...progress, startedAt, budgetMs };
    job.phase = progress.step === "propose" ? `Preparing correction ${progress.attempt} of 2`
      : progress.step === "verify" ? `Checking correction ${progress.attempt} of 2 against the source`
      : "Checking the opening, meaning, and ending";
  };
  update({ step: "review", attempt: 0 });
  try { return await work(update); }
  finally { delete job.editorialProgress; }
}

/** Release the worker even if output cleanup or history construction itself throws. */
async function runWithRelease(job: StoredJob, controller: AbortController) {
  try { await withJobUsage(job, () => run(job, controller)); }
  catch (error) {
    console.error(`Unable to finish export cleanup [${job.id}]:`, error);
    if (job.status === "processing") {
      job.status = job.cancelledByUser ? "cancelled" : "failed";
      job.finishedAt = new Date().toISOString();
      delete job.phase;
      job.error = job.cancelledByUser ? undefined : "The export could not finish saving its result. Check the workspace drive and retry.";
    }
    await saveStore().catch(saveError => console.error("Unable to save export state:", saveError));
  } finally {
    running.delete(job.id);
    runningPromises.delete(job.id);
    selecting.delete(job.id);
    selected.delete(job.id);
    if (job.status !== "queued") waitingFor.delete(job.id);
    pumpQueue();
  }
}

async function run(job: StoredJob, controller: AbortController) {
  const workDir = path.join(paths.work, job.id);
  let status: "completed" | "failed" | "cancelled" | "skipped" | "queued" = "failed";
  let reservationIds: string[] = [];
  let errorMessage: string | undefined;
  let retryable = true;
  let outputSize: number | undefined;
  let thumbnail: HistoryThumbnail | undefined;
  const savedRepair = job.editorialRepair;
  delete job.qualityReport;
  delete job.finishedReviewReport;
  delete job.editorialReport;
  delete job.visualSearch;
  delete job.editorialProgress;
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
    const upscale = job.auto && !job.editPlan ? job.auto.upscale : job.settings.upscale;
    if (upscale && upscale !== "off") await assertUpscaleInstalled();
    await preflightWatermarkRemoval(job.auto && !job.editPlan ? job.auto.watermarkRemoval : job.settings.watermarkRemoval,
      Math.max(2, Math.floor(source.width / 2) * 2), Math.max(2, Math.floor(source.height / 2) * 2), source.duration);
    if (!source.fingerprint) {
      source.fingerprint = await fingerprintFile(source.filePath, controller.signal);
      // Known, different sources may now use the remaining worker slots.
      pumpQueue();
    }
    source.picture ??= await visualIdentity(source.filePath, source.duration, controller.signal);
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
    let captionWords: TranscriptWord[] | undefined;
    const automaticManual = !job.auto && !job.editPlan && wantsManualCaptions(job.settings);
    if (automaticManual) subtitlePath = undefined;
    let supportingVisuals: SupportingVisual[] = [];
    if (job.editPlan) {
      if (job.refreshBroll) {
        job.settings = structuredClone(job.editPlan.settings);
        const occupied = preservedVisualsOnStockRefresh(job.editPlan, job.preserveBroll).filter(item => item.enabled);
        const options = job.auto;
        const requested = Math.max(0, (options?.brollCount ?? DEFAULT_BROLL_COUNT) - occupied.length);
        // Reuse saved graphics/library shots. Only the remaining stock slots
        // are searched, without mutating the persisted visual preferences.
        const visuals = requested ? await prepareSupportingVisuals({ source, job,
          options: { ...options!, visualSources: stockProvidersForEdit(options), brollCount: requested },
          transcript: transcriptFromPlan(job), assets: [], occupied,
          excludedStockIds: occupied.flatMap(shot => { const id = job.editPlan!.media.find(media => media.id === shot.mediaId)?.stock?.providerId; return id ? [id] : []; }),
          workDir, signal: controller.signal, onPhase: (phase, progress) => {
            job.phase = phase; job.progress = Math.max(job.progress, progress);
          } }) : [];
        if (!requested) (job.notes ??= []).push("Saved animations and library shots already fill the shot target. Increase the target to add stock shots.");
        if (requested || options?.brollMaxCoverage !== undefined) await refreshPlanBroll(job, visuals, controller.signal);
        const keptShots = job.editPlan.visuals.filter(item => item.enabled);
        job.notes = (job.notes || []).filter(note => !/^(?:B-roll target:|Supporting visual target:|Visual mix —)/u.test(note));
        job.notes.push(`Supporting visual target: ${keptShots.length} of ${options?.brollCount ?? DEFAULT_BROLL_COUNT} shots added or retained.`);
        if (job.visualFulfillment) job.visualFulfillment = { ...job.visualFulfillment, requested: options?.brollCount ?? DEFAULT_BROLL_COUNT, placed: keptShots.length };
        const selected = getVisualSources(options);
        if (selected.length > 1) job.notes.push(`Visual mix — ${selected.map(source => {
          const count = keptShots.filter(shot => job.editPlan!.media.find(media => media.id === shot.mediaId)?.visualSource === source).length;
          return `${VISUAL_SOURCE_LABELS[source]}: ${count}`;
        }).join(" · ")}.`);
        delete job.refreshBroll;
        delete job.preserveBroll;
        await saveStore();
      }
      job.phase = "Rendering your saved edit";
      const saved = await renderInputsFromPlan(job, workDir);
      audioPath = saved.audioPath;
      subtitlePath = saved.subtitlePath;
      captionWords = saved.captionWords;
      supportingVisuals = saved.supportingVisuals;
    } else if (job.auto) {
      const reservations = state.jobs.filter(other => other.id !== job.id &&
        other.status === "processing" && other.auto && (selected.has(other.id) || other.editPlan) &&
        other.batchId === job.batchId && other.sourceId === job.sourceId);
      reservationIds = reservations.map(other => other.id);
      const prepared = await prepareAutoRemix({
        source,
        job,
        workDir,
        signal: controller.signal,
        previous: state.jobs,
        reserved: reservations,
        historyPlans: previousEditorialPlans(historyRecords({ fingerprint: source.fingerprint }), source.fingerprint),
        onPhase: (phase, progress) => {
          job.phase = phase;
          job.progress = Math.max(job.progress, Math.round(progress));
        },
      });
      job.settings = prepared.settings;
      if (job.auto.ownFootage?.length) { job.settings.ownFootage = structuredClone(job.auto.ownFootage); job.settings.ownFootageSourceId = job.sourceId; }
      job.summary = prepared.summary;
      job.notes = prepared.notes;
      controller.signal.throwIfAborted();
      // Publish selected cuts before admitting the next version. Other workers
      // can avoid these cuts while this job searches B-roll and renders.
      selected.add(job.id);
      selecting.delete(job.id);
      pumpQueue();
      audioPath = prepared.audioPath;
      subtitlePath = prepared.subtitlePath;
      supportingVisuals = await prepareSupportingVisuals({
        source,
        job,
        occupied: footageTimeline(job.settings.ownFootage, job.summary.outputDuration, source.fps).covers.map(item => ({ start: item.at, end: item.at + item.length })),
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
        sourceTranscript: prepared.sourceTranscript, captionWords: prepared.transcript?.segments.flatMap(segment => segment.words), signal: controller.signal });
      job.phase = "Rendering your edit";
      await saveStore();
    } else {
      supportingVisuals = await prepareManualVisuals({ source, job, assets: state.broll, audioPath,
        workDir, signal: controller.signal, onPhase: (phase, progress) => {
          job.phase = phase; job.progress = Math.max(job.progress, progress);
        } });
      job.phase = "Rendering your manual edit";
    }
    if (job.editPlan && job.auto) {
      const requestedMode = job.auto.editorialMode ?? "repair";
      // Full-length exports are an explicit timing choice; automatic review must never recut them.
      const mode = job.auto.durationMode === "full" && requestedMode === "repair" ? "check" : requestedMode;
      job.editorialModeApplied = mode;
      if (mode !== "off") {
        if (mode === "repair" && !savedRepair) {
          const reviewed = await trackEditorialReview(job, EDITORIAL_REPAIR_BUDGET_MS, onProgress => repairEditorialPlan({ plan: job.editPlan!,
            transcript: job.sourceTranscript, sourcePath: source.filePath, signal: controller.signal, onProgress,
            maxDuration: job.auto!.targetDuration, protectedEdit: Boolean(job.parentJobId) }));
          job.editPlan = reviewed.plan;
          job.editorialReport = reviewed.report;
          job.editorialRepair = reviewed.repairLog;
        } else {
          job.editorialReport = await trackEditorialReview(job, AI_REQUEST_BUDGET_MS + 5_000, () => reviewEditorialPlan({ plan: job.editPlan!,
            transcript: job.sourceTranscript, sourcePath: source.filePath, signal: controller.signal }));
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
        job.editorialReport = await trackEditorialReview(job, AI_REQUEST_BUDGET_MS + 5_000, () => reviewEditorialPlan({ plan: job.editPlan!,
          transcript: job.sourceTranscript, sourcePath: source.filePath, signal: controller.signal }));
        if (job.editorialRepair) job.editorialRepair.finalReport = structuredClone(job.editorialReport);
      }
      // Rebuild every render input from the final reviewed plan. This also writes
      // retimed captions, so a verified boundary/hook fix reaches the actual MP4.
      const saved = await renderInputsFromPlan(job, workDir);
      audioPath = saved.audioPath;
      subtitlePath = saved.subtitlePath;
      captionWords = saved.captionWords;
      supportingVisuals = saved.supportingVisuals;
      if (job.summary && job.editPlan.settings.hookText) job.summary.title = job.editPlan.settings.hookText;
      job.phase = mode === "off" ? "Rendering your saved edit" : "Rendering the reviewed edit";
      await saveStore();
    }
    if (job.draftReview && job.summary && !job.editPlan && !automaticManual) {
      // Approved short drafts need the same user-controlled revision workflow as Auto exports.
      await captureEditPlan({ job, source, visuals: supportingVisuals, audioPath, subtitlePath, signal: controller.signal });
    }
    const ownFootage = await retainFootage(job, controller.signal);
    if (ownFootage.length) {
      const baseDuration = job.editPlan?.outputDuration ?? (job.settings.segments?.reduce((sum, cut) => sum + cut.end - cut.start, 0) ?? (Math.min(job.settings.trimEnd ?? source.duration, source.duration) - job.settings.trimStart)) / job.settings.speed;
      const covers = footageTimeline(job.settings.ownFootage, baseDuration, job.settings.fps === "source" ? source.fps : Number(job.settings.fps)).covers;
      const visible = (shot: { start: number; end: number }) => covers.every(item => shot.end <= item.at || shot.start >= item.at + item.length);
      supportingVisuals = supportingVisuals.filter(visible);
      job.supportingVisuals = job.supportingVisuals?.filter(visible);
      if (job.editPlan) for (const shot of job.editPlan.visuals) if (!visible(shot)) shot.enabled = false;
      for (const clip of ownFootage.filter(clip => !clip.placement.appendToEnd && clip.placement.at >= baseDuration))
        (job.notes ??= []).push(clip.placement.mode === "insert" ? `${clip.name}: the requested position is past this edit's end. The clip was appended at ${baseDuration.toFixed(2)}s.` : `${clip.name}: the cover position is past this edit's end and was omitted. Adjust its timestamp in Edit this result.`);
    }
    if (automaticManual) job.phase = "Preparing the soundtrack for automatic captions";
    await saveStore();
    await renderVideo({
      onPhase: phase => { job.phase = phase; },
      ownFootage,
      input: source.filePath,
      output: job.outputPath,
      source,
      settings: job.settings,
      audioPath,
      subtitlePath,
      captionWords,
      supportingVisuals,
      workDir,
      signal: controller.signal,
      onProgress: (progress) => {
        job.progress = Math.max(
          job.progress,
          Math.min(99, Math.round(job.auto ? 65 + progress * 0.34 : automaticManual ? progress * 0.6 : progress)),
        );
      },
    });
    if (controller.signal.aborted) throw new Error("Cancelled");
    if (automaticManual) {
      const result = await addManualCaptions({ output: job.outputPath, settings: job.settings, workDir,
        signal: controller.signal, onPhase: (phase, progress) => {
          job.phase = phase; job.progress = Math.max(job.progress, Math.round(progress));
        } });
      subtitlePath = result.subtitlePath;
      job.notes = [...new Set([...(job.notes || []), result.note, ...(result.detail ? [result.detail] : [])])];
      if (job.summary && subtitlePath) {
        job.summary.transcriptAvailable = true;
        job.summary.changes = [...new Set([...job.summary.changes, "Automatic captions"])];
      }
    }
    await assertLinkedSourceUnchanged(source);
    job.phase = "Checking the rendered video";
    job.qualityReport = await inspectExport({ output: job.outputPath, source,
      settings: job.settings, audioPath, supportingVisuals, ownFootage, signal: controller.signal });
    let captions = job.editPlan?.captions || [];
    if (!job.editPlan && subtitlePath) {
      try { captions = parseCaptionCues(await readFile(subtitlePath, "utf8")); }
      catch { job.qualityReport.issues.push({ code: "caption-check", message: "Caption layout could not be checked. Review the burned captions." }); }
    }
    const outputGeometry = geometry(source, job.settings);
    job.qualityReport.issues.push(...textLayoutIssues({ settings: job.settings, captions }, outputGeometry.width / outputGeometry.height));
    if (job.qualityReport.issues.length) job.qualityReport.status = "review";
    if (job.auto?.finishedReview !== false) {
      job.phase = "Reviewing the finished picture and sound";
      await saveStore();
      job.finishedReviewReport = await reviewJobFinished(job, source, controller.signal, workDir, captions);
    }
    if ((job.auto || automaticManual) && subtitlePath) {
      job.captionPath = path.join(paths.outputs, `${job.id}.srt`);
      if (job.auto && job.settings.ownFootage?.some(item => item.mode === "insert")) {
        const baseDuration = job.editPlan!.outputDuration;
        await writeFile(job.captionPath, captionCuesSrt(captionsAfterInserts(captions, job.settings.ownFootage, baseDuration, job.settings.fps === "source" ? source.fps : Number(job.settings.fps))), "utf8");
      } else await copyFile(subtitlePath, job.captionPath);
    }
    if (job.summary && job.settings.ownFootage?.length) {
      const timeline = footageTimeline(job.settings.ownFootage, job.editPlan?.outputDuration ?? job.summary.outputDuration, job.settings.fps === "source" ? source.fps : Number(job.settings.fps));
      job.summary.outputDuration = timeline.duration;
      if (timeline.inserts.length) job.summary.changes.push(`${timeline.inserts.length} uploaded segment${timeline.inserts.length === 1 ? "" : "s"} inserted`);
      if (timeline.covers.length) job.summary.changes.push(`${timeline.covers.length} uploaded cover shot${timeline.covers.length === 1 ? "" : "s"}`);
    }
    job.outputPicture = await visualIdentity(job.outputPath, (await probeMedia(job.outputPath, controller.signal)).duration, controller.signal);
    outputSize = (await stat(job.outputPath)).size;
    status = "completed";
  } catch (error) {
    retryable = canRetryRender(error);
    // Exhausted in-flight reservations are provisional. Release this worker and
    // retry selection after those jobs settle; a failed/cancelled job reserves nothing.
    const unsettled = reservationIds.filter(id => state.jobs.find(other => other.id === id)?.status !== "completed");
    if (!controller.signal.aborted && error instanceof AutoSkipError && unsettled.length) {
      waitingFor.set(job.id, unsettled.filter(id => running.has(id)));
      status = "queued";
    } else status = controller.signal.aborted
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
    if (!controller.signal.aborted && status !== "skipped") {
      job.diagnostic = serverDiagnostic(error, { entityId: job.id, operation: "Export video" });
      console.error(`Export failed [${job.diagnostic.id}] [${job.id}]:`, error);
    }
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
    if (controller.signal.aborted) {
      recoverInterruptedJob(job);
      status = job.status as typeof status;
      errorMessage = job.error;
    } else if (status === "failed") {
      scheduleJobRetry(job, errorMessage || "Rendering failed.", "failure", retryable);
      status = job.status as typeof status;
    }
    job.status = status;
    job.phase =
      status === "completed"
        ? job.qualityReport?.status === "review" || (job.finishedReviewReport && job.finishedReviewReport.status !== "pass") || (job.editorialReport && job.editorialReport.status !== "pass") ? "Needs review" : "Ready to preview"
        : status === "skipped"
          ? "Skipped"
          : status === "queued" && job.retry?.nextRetryAt ? retryPhase(job) : undefined;
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
    if (status === "queued") { delete job.finishedAt; job.progress = 0; }
    else job.finishedAt = new Date().toISOString();
    const source = state.sources.find(item => item.id === job.sourceId);
    // Concurrent duplicate imports can finish in either order. Compare again
    // when exporting, so the later completion sees the earlier export's history.
    if (status === "completed" && job.auto && source?.fingerprint) {
      const cuts = job.settings.segments || [{ start: job.settings.trimStart, end: job.settings.trimEnd ?? source.duration }];
      const earlier = previousEditorialPlans(historyRecords({ fingerprint: source.fingerprint }).filter(entry => entry.jobId !== job.id), source.fingerprint);
      if (earlier.some(plan => footageContainment(cuts, plan.cuts) >= 0.8))
        job.notes = [...new Set([...(job.notes || []), "This edit reuses footage from an earlier export. Open History to compare."])];
    }
    if (status === "completed" && source && historyMatches(source).some(entry => entry.id !== job.id && entry.match?.kind !== "exact"))
      job.notes = [...new Set([...(job.notes || []), "The picture resembles an earlier source or export. Open History to compare this possible re-export; rendering is allowed."])];
    const entry = source && historyEntry(source, job);
    if (entry && thumbnail) { entry.thumbnailUrl = thumbnail.url; entry.thumbnailKind = thumbnail.kind; }
    const historyUpdates = entry ? upsertHistory(historyRecords({ jobId: entry.jobId }), entry) : [];
    await saveStore(historyUpdates).catch((error) =>
      console.error("Unable to save render result:", error),
    );
  }
}
export async function cancelJob(job: StoredJob) {
  if (!isActive(job)) return;
  // Persist intent before aborting so even a simultaneous process crash cannot
  // make startup recovery resurrect a job the user deliberately stopped.
  const previousIntent = job.cancelledByUser;
  const controller = running.get(job.id);
  job.cancelledByUser = true;
  try { await saveStore(); }
  catch (error) { job.cancelledByUser = previousIntent; throw error; }
  if (job.retry) delete job.retry.nextRetryAt;
  if (controller) {
    controller.abort();
    const promise = runningPromises.get(job.id);
    if (promise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  // An active worker owns its files until it settles. Never race its cleanup after a timeout.
  if (!running.has(job.id) && isActive(job)) {
    await Promise.all([
      rm(path.join(paths.work, job.id), { recursive: true, force: true }),
      rm(job.outputPath, { force: true }),
      rm(historyThumbnailPath(job.id), { force: true }),
      ...(job.captionPath ? [rm(job.captionPath, { force: true })] : []),
    ]);
    waitingFor.delete(job.id);
    selecting.delete(job.id);
    selected.delete(job.id);
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    delete job.phase;
    delete job.error;
    delete job.captionPath;
    delete job.captionUrl;
    delete job.downloadUrl;
    delete job.outputSize;
  }
  await saveStore();
  pumpQueue();
}
export async function stopQueue() {
  stopped = true;
  clearTimeout(retryTimer);
  retryTimer = undefined;
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
      !job.keptAt && !job.editorDraft &&
      !publishingJobs.has(job.id) &&
      !isActive(job) &&
      !running.has(job.id) &&
      expired(job.retentionResetAt || job.finishedAt || job.createdAt),
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
    (source) => expired(source.createdAt) && !referencedSources.has(source.id) && !Object.values(source.draftOwners || {}).some(ids => ids.length),
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
