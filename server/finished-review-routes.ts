import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { Express } from "express";
import { state, publicJob, saveStore } from "./store.js";
import { paths } from "./config.js";
import { isRunning } from "./queue.js";
import { reviewJobFinished } from "./finished-review-jobs.js";
import type { FinishedReviewDependencies } from "./finished-review.js";

/** Inspect the immutable export again without changing its settings or re-encoding it. */
export function installFinishedReviewRoutes(app: Express, dependencies: FinishedReviewDependencies = {}) {
  const active = new Map<string, AbortController>();
  app.post("/api/jobs/:id/finished-review", async (req, res) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))
      return res.status(400).json({ error: "Review the saved export without sending editing changes." });
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job) return res.status(404).json({ error: "This export was removed or expired." });
    if (job.status !== "completed" || isRunning(job.id)) return res.status(409).json({ error: "Wait for the export to finish rendering." });
    if (active.has(job.id)) return res.status(409).json({ error: "The finished-video review is already running." });
    if (active.size >= 2) return res.status(429).json({ error: "Two finished-video reviews are running. Wait for one to finish." });
    const controller = new AbortController(); active.set(job.id, controller);
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    const directory = path.join(paths.work, `review-${randomUUID()}`);
    try {
      const report = await reviewJobFinished(job, state.sources.find(item => item.id === job.sourceId), controller.signal, directory, undefined, dependencies);
      controller.signal.throwIfAborted();
      if (!state.jobs.includes(job) || job.status !== "completed" || isRunning(job.id))
        return res.status(409).json({ error: "The export changed or was removed during review." });
      const previous = job.finishedReviewReport;
      const previousPhase = job.phase;
      const history = state.history.filter(entry => entry.jobId === job.id).map(entry => ({ entry, previous: entry.finishedReviewReport }));
      job.finishedReviewReport = report;
      job.phase = report.status !== "pass" || job.qualityReport?.status === "review" || (job.editorialReport && job.editorialReport.status !== "pass") ? "Needs review" : "Ready to preview";
      for (const item of history) item.entry.finishedReviewReport = structuredClone(report);
      try { await saveStore(); }
      catch {
        job.finishedReviewReport = previous; job.phase = previousPhase;
        for (const item of history) item.entry.finishedReviewReport = item.previous;
        return res.status(500).json({ error: "The review could not be saved. Try again." });
      }
      res.json(publicJob(job));
    } catch {
      if (!res.destroyed && !res.headersSent) res.status(503).json({ error: "Finished-video review was interrupted. The export is unchanged; retry the review." });
    } finally {
      active.delete(job.id); res.off("close", disconnected);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
