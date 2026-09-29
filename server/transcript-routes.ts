import type { Express } from "express";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { paths } from "./config.js";
import { state } from "./store.js";
import { cachedSourceTranscript, sourceTranscript } from "./auto.js";
import { assertLinkedSourceUnchanged, ImportError } from "./media-imports.js";
import { transcriptionAvailable } from "./transcription.js";
import type { TranscriptEvent } from "../shared/transcript-edit.js";

const schema = z.object({ sourceId: z.string().uuid() }).strict();

/** Word-timed source transcripts for editing shorts by their speech. Transcription stays local. */
export function installTranscriptRoutes(app: Express, dependencies = { cached: cachedSourceTranscript, transcribe: sourceTranscript, available: transcriptionAvailable }) {
  app.get("/api/shorts/transcript/:sourceId", async (req, res) => {
    const source = state.sources.find(item => item.id === req.params.sourceId);
    if (!source) return res.status(404).json({ error: "This video is no longer available. Reimport it first." });
    res.setHeader("Cache-Control", "no-store");
    if (!source.hasAudio) return res.json({ transcript: null });
    try {
      await assertLinkedSourceUnchanged(source);
      return res.json({ transcript: await dependencies.cached(source) });
    } catch (error) {
      if (error instanceof ImportError) return res.status(error.status).json({ error: error.message });
      return res.json({ transcript: null });
    }
  });
  // One preparation per source. A quickly repeated request after a cancelled one can retry.
  const busy = new Set<string>();
  app.post("/api/shorts/transcript", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a source video to transcribe." });
    const source = state.sources.find(item => item.id === parsed.data.sourceId);
    if (!source) return res.status(404).json({ error: "This video is no longer available. Reimport it first." });
    if (!source.hasAudio) return res.status(422).json({ error: "This video has no audio to transcribe. You can still set timestamps by hand." });
    if (busy.has(source.id)) return res.status(409).json({ error: "This transcript is already being prepared. Try again in a moment." });
    busy.add(source.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60_000); timeout.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    let directory: string | undefined;
    const send = (event: TranscriptEvent) => { if (!res.destroyed && !controller.signal.aborted) res.write(`${JSON.stringify(event)}\n`); };
    try {
      await assertLinkedSourceUnchanged(source);
      await mkdir(paths.work, { recursive: true });
      directory = await mkdtemp(path.join(paths.work, "transcript-"));
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders();
      send({ type: "progress", message: "Preparing the local transcript…", progress: 1 });
      const transcript = await dependencies.transcribe(source, directory, controller.signal,
        progress => send({ type: "progress", message: `Transcribing speech · ${Math.round(progress)}%`, progress }));
      controller.signal.throwIfAborted();
      send({ type: "result", transcript }); res.end();
    } catch (error) {
      if (res.destroyed) return;
      const message = error instanceof ImportError ? error.message : controller.signal.aborted
        ? "Transcription timed out. Retry to continue."
        : await dependencies.available()
          ? "The transcript could not be prepared. Retry, or keep setting timestamps by hand."
          : "Transcripts need the local speech model. Run npm run setup:auto, then retry.";
      if (!res.headersSent) res.status(error instanceof ImportError ? error.status : 422).json({ error: message });
      else { res.write(`${JSON.stringify({ type: "error", message } satisfies TranscriptEvent)}\n`); res.end(); }
    } finally {
      clearTimeout(timeout); res.removeListener("close", disconnected); busy.delete(source.id);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
