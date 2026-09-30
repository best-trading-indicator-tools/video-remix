import { serverDiagnostic } from "./diagnostics.js";
import type { Express } from "express";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { paths } from "./config.js";
import path from "node:path";
import { discoveryRequestSchema, findBestClips } from "./clip-discovery.js";
import { sourceTranscript } from "./auto.js";
import { assertLinkedSourceUnchanged, ImportError } from "./media-imports.js";
import { state, historyRecords } from "./store.js";
import { draftHistoryMatches, draftHistorySchema } from "./draft-history.js";
import type { ExportHistoryEntry } from "../shared/types.js";
import type { DraftHistoryResult } from "../shared/draft-history.js";
import type { DiscoveryEvent } from "../shared/clip-discovery.js";

export function installClipDiscoveryRoutes(app: Express, dependencies = { transcript: sourceTranscript, discover: findBestClips }) {
  app.post("/api/shorts/review-history", (req, res) => {
    const parsed = draftHistorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Send up to 100 drafts with valid source timestamps." });
    const cache = new Map<string, ExportHistoryEntry[]>();
    const drafts: DraftHistoryResult[] = [];
    for (const draft of parsed.data.drafts) {
      const source = state.sources.find(item => item.id === draft.sourceId);
      if (source && draft.cuts.some(cut => cut.end > source.duration + 0.001))
        return res.status(400).json({ error: "Draft timestamps must stay within their source video." });
      if (!source?.fingerprint) {
        drafts.push({ id: draft.id, status: source ? "identity-unavailable" : "source-unavailable", matches: [], total: 0 }); continue;
      }
      let entries = cache.get(source.fingerprint);
      if (!entries) { entries = historyRecords({ fingerprint: source.fingerprint }); cache.set(source.fingerprint, entries); }
      drafts.push({ id: draft.id, status: "checked", ...draftHistoryMatches(draft.cuts, entries) });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.json({ drafts });
  });
  let busy = false;
  app.post("/api/shorts/discover", async (req, res) => {
    const parsed = discoveryRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose 1–20 clips, valid whole-second minimum and maximum lengths, and a brief up to 1,200 characters." });
    const source = state.sources.find(item => item.id === parsed.data.sourceId);
    if (!source) return res.status(404).json({ error: "This video is no longer available. Reimport it first." });
    if (!source.hasAudio) return res.status(422).json({ error: "This discovery mode needs spoken audio. You can still create clips with timestamps." });
    if (busy) return res.status(409).json({ error: "Another discovery is running. Finish or cancel it before starting another." });
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60_000); timeout.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    let directory: string | undefined;
    const send = (event: DiscoveryEvent) => { if (!res.destroyed && !controller.signal.aborted) res.write(`${JSON.stringify(event)}\n`); };
    try {
      await assertLinkedSourceUnchanged(source);
      await mkdir(paths.work, { recursive: true });
      directory = await mkdtemp(path.join(paths.work, "discovery-"));
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders();
      send({ type: "progress", message: "Preparing the local transcript…", progress: 1 });
      const transcript = await dependencies.transcript(source, directory, controller.signal,
        progress => send({ type: "progress", message: `Transcribing speech · ${Math.round(progress)}%`, progress: progress * 0.4 }));
      const result = await dependencies.discover({ transcript, sourceDuration: source.duration, options: parsed.data, signal: controller.signal,
        onProgress: (message, progress) => send({ type: "progress", message, progress }) });
      controller.signal.throwIfAborted();
      send({ type: "result", result }); res.end();
    } catch (error) {
      if (res.destroyed) return;
      const message = error instanceof ImportError ? error.message : controller.signal.aborted
        ? "Discovery timed out. Retry to reuse completed analysis."
        : "Clip discovery could not finish. Check that the local speech model and DeepSeek are configured, then retry. Completed sections are cached.";
      const diagnostic = serverDiagnostic(error, { operation: "Find clips", entityId: source.id,
        id: res.locals.requestId, requestId: res.locals.requestId, message,
        endpoint: req.path, method: req.method, httpStatus: res.headersSent ? 200 : error instanceof ImportError ? error.status : 422 });
      console.error(`Find clips failed [${diagnostic.id}]:`, error);
      if (!res.headersSent) res.status(error instanceof ImportError ? error.status : 422).json({ error: message, diagnostic });
      else { res.write(`${JSON.stringify({ type: "error", message, diagnostic })}\n`); res.end(); }
    } finally {
      clearTimeout(timeout); res.removeListener("close", disconnected); busy = false;
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
