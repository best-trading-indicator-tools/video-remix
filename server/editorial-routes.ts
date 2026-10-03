import { historyRecords, reconcileHistory } from "./store.js";
import { AI_REQUEST_BUDGET_MS } from "./ai-json.js";
import { createHash } from "node:crypto";
import type { Express } from "express";
import type { EditorialReviewer } from "../shared/editorial.js";
import { reviewEditorialPlan } from "./editorial-review.js";
import { isRunning } from "./queue.js";
import { publicJob, saveStore, state, type StoredJob } from "./store.js";
import { assertLinkedSourceUnchanged } from "./media-imports.js";
import type { VisualEditorialReviewer } from "./editorial-visual-review.js";

interface ReviewRouteOptions {
  /** Replies still pass through the production review and evidence validation. */
  reviewer?: EditorialReviewer;
  visualReviewer?: VisualEditorialReviewer;
  isJobRunning?: (id: string) => boolean;
  /** A smaller budget is useful to verify cancellation without waiting a minute. */
  timeoutMs?: number;
}
const signature = (job: StoredJob) => createHash("sha256")
  .update(JSON.stringify({ plan: job.editPlan, transcript: job.sourceTranscript, settings: job.settings })).digest("hex");

/** Recheck saved evidence without rendering media or proposing/applying repairs. */
export function installEditorialReviewRoutes(app: Express, options: ReviewRouteOptions = {}) {
  const active = new Map<string, AbortController>();
  const running = options.isJobRunning || isRunning;
  const timeoutMs = Math.max(1, Math.min(AI_REQUEST_BUDGET_MS + 15_000, options.timeoutMs ?? AI_REQUEST_BUDGET_MS + 15_000));
  app.post("/api/jobs/:id/editorial-review", async (req, res) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))
      return res.status(400).json({ error: "This action reviews the saved edit and does not accept editing changes." });
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: "This export was removed or expired." });
    if (!job.auto || !job.editPlan)
      return res.status(409).json({ error: "This export has no saved automatic edit to review." });
    if (job.status !== "completed" || running(job.id))
      return res.status(409).json({ error: "Wait until this export has finished rendering before reviewing it." });
    if (active.has(job.id)) return res.status(409).json({ error: "An editorial review is already running for this export." });
    if (active.size >= 2) return res.status(429).json({ error: "Two editorial reviews are already running. Wait for one to finish." });

    const controller = new AbortController();
    active.set(job.id, controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    try {
      const originalPlan = job.editPlan;
      const originalRevision = originalPlan.revision;
      const originalSignature = signature(job);
      const source = state.sources.find(item => item.id === originalPlan.sourceId);
      let sourcePath = source?.filePath;
      if (source) try { await assertLinkedSourceUnchanged(source); }
      catch { controller.signal.throwIfAborted(); sourcePath = undefined; }
      const report = await reviewEditorialPlan({ plan: structuredClone(originalPlan),
        transcript: job.sourceTranscript ? structuredClone(job.sourceTranscript) : undefined,
        sourcePath, visualReviewer: options.visualReviewer,
        signal: controller.signal, ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      });
      controller.signal.throwIfAborted();
      if (!state.jobs.includes(job)) return res.status(409).json({ error: "The export was removed while its review was running." });
      if (job.status !== "completed" || running(job.id) || job.editPlan !== originalPlan ||
        job.editPlan.revision !== originalRevision || signature(job) !== originalSignature)
        return res.status(409).json({ error: "The saved edit changed during review. Review its current version again." });
      if (report.coverage.source === "visual" && (!source || !state.sources.includes(source) || source.filePath !== sourcePath))
        return res.status(409).json({ error: "The original video changed during review. Review its current version again." });

      const previous = { report: job.editorialReport, repair: job.editorialRepair, phase: job.phase };
      const nextReport = structuredClone(report);
      const nextRepair = job.editorialRepair ? { ...job.editorialRepair, finalReport: structuredClone(report) } : undefined;
      const nextPhase = job.qualityReport?.status === "review" || (job.finishedReviewReport && job.finishedReviewReport.status !== "pass") || report.status !== "pass" ? "Needs review" : "Ready to preview";
      const historyUpdates = historyRecords({ jobId: job.id }).map(entry => ({
        entry, previousReport: entry.editorialReport, previousRepair: entry.editorialRepair,
        report: structuredClone(report), repair: entry.editorialRepair ? { ...entry.editorialRepair, finalReport: structuredClone(report) } : undefined,
      }));
      job.editorialReport = nextReport;
      if (nextRepair) job.editorialRepair = nextRepair;
      job.phase = nextPhase;
      for (const update of historyUpdates) {
        update.entry.editorialReport = update.report;
        if (update.repair) update.entry.editorialRepair = update.repair;
      }
      try { await saveStore(historyUpdates.map(update => update.entry)); }
      catch {
        // Roll back only fields owned by this request. Publication measurements,
        // repairs and job state changed elsewhere must not be overwritten.
        if (job.editorialReport === nextReport) {
          if (previous.report) job.editorialReport = previous.report; else delete job.editorialReport;
        }
        if (nextRepair && job.editorialRepair === nextRepair) job.editorialRepair = previous.repair;
        if (job.phase === nextPhase) job.phase = previous.phase;
        for (const update of historyUpdates) {
          if (update.entry.editorialReport === update.report) {
            if (update.previousReport) update.entry.editorialReport = update.previousReport; else delete update.entry.editorialReport;
          }
          if (update.repair && update.entry.editorialRepair === update.repair) update.entry.editorialRepair = update.previousRepair;
        }
        if (!res.destroyed) return res.status(503).json({ error: "The editorial review could not be saved. Try again." });
        return;
      }
      if (!res.destroyed) return res.json(publicJob(job));
    } catch {
      if (res.destroyed) return;
      if (timedOut) return res.status(504).json({ error: "The editorial review took too long. Try reviewing this export again." });
      return res.status(503).json({ error: "The editorial review could not finish. Try again." });
    } finally {
      clearTimeout(timer);
      res.removeListener("close", disconnected);
      active.delete(job.id);
    }
  });
}
