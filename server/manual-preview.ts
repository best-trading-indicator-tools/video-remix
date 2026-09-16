import type { Express } from "express";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RemixSettings } from "../shared/types.js";
import { withTrackBounds } from "../shared/focus.js";
import { config } from "./config.js";
import { geometry, probeMedia, renderVideo, type MediaInfo } from "./engine.js";
import { settingsSchema } from "./schema.js";
import { state } from "./store.js";
import { assertLinkedSourceUnchanged, ImportError } from "./media-imports.js";

const PREVIEW_SECONDS = 5;
const TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 12;
const TIMEOUT_MS = 60_000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const requestSchema = z.object({ sourceId: z.string().uuid(), settings: settingsSchema }).strict();

class PreviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Resolve the full edit's shifted start before shortening its preview window. */
export function manualPreviewSettings(settings: RemixSettings, source: MediaInfo) {
  if (settings.hookText.includes("\0") || settings.callouts?.some(cue => cue.text.includes("\0")))
    throw new PreviewError(400, "Text cannot contain null characters.");
  const preview: RemixSettings = {
    ...settings, resolution: "source",
    fps: settings.fps === "source" && source.fps > 60 ? "60" : settings.fps,
  };
  const maximumLength = PREVIEW_SECONDS * settings.speed;
  let length = 0;
  let fullLength = 0;
  if (settings.segments?.length) {
    if (settings.segments.some(cut => cut.end > source.duration + 0.001))
      throw new PreviewError(400, "Selected cuts must stay within the source video.");
    fullLength = settings.segments.reduce((total, cut) => total + cut.end - cut.start, 0);
    preview.segments = [];
    for (const cut of settings.segments) {
      const retained = Math.min(cut.end - cut.start, maximumLength - length);
      // The renderer requires each cut to contain at least 0.04 source seconds.
      if (retained <= 0.04) break;
      preview.segments.push(withTrackBounds({ ...cut, end: cut.start + retained }));
      length += retained;
      if (length >= maximumLength) break;
    }
    preview.trimStart = 0;
    preview.trimEnd = null;
    preview.timeShift = 0;
  } else {
    const end = settings.trimEnd ?? source.duration;
    if (end > source.duration + 0.05 || settings.trimStart >= end - 0.05)
      throw new PreviewError(400, "Trim end must be after the start and within the source video.");
    fullLength = Math.min(end, source.duration) - settings.trimStart;
    const start = Math.max(0, Math.min(settings.trimStart + settings.timeShift, source.duration - fullLength));
    length = Math.min(fullLength, maximumLength);
    preview.trimStart = start;
    preview.trimEnd = start + length;
    preview.timeShift = 0;
  }
  if (length <= 0.04) throw new PreviewError(400, "Choose a longer interval to preview.");
  if (preview.ownFootage) preview.ownFootage = preview.ownFootage.filter(item => item.appendToEnd
    ? fullLength <= length + 1e-9 : item.at < length / settings.speed);
  // Limit unusual panoramic source formats as well as ordinary 720p exports.
  // The renderer scales display pixels first, so this preserves crop positions.
  const output = geometry(source, preview);
  const scale = Math.min(1, 720 / Math.min(output.width, output.height), 1280 / Math.max(output.width, output.height));
  const previewSource = scale === 1 ? source : {
    ...source,
    width: Math.max(2, Math.floor(source.width * scale / 2) * 2),
    height: Math.max(2, Math.floor(source.height * scale / 2) * 2),
  };
  return { settings: preview, source: previewSource, duration: length / settings.speed, motionDuration: fullLength / settings.speed };
}

interface Preview {
  id: string;
  key: string;
  duration: number;
  createdAt: number;
}

export function installManualPreviewRoutes(app: Express) {
  const directory = path.join(config.dataDir, "previews");
  const previews = new Map<string, Preview>();
  let active: string | undefined;
  let maintenance = Promise.resolve();
  const discard = async (id: string) => {
    previews.delete(id);
    await rm(path.join(directory, id), { recursive: true, force: true });
  };
  const cleanup = () => {
    maintenance = maintenance.catch(() => undefined).then(async () => {
      await mkdir(directory, { recursive: true });
      const now = Date.now();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!UUID.test(entry.name) || entry.name === active) continue;
        const preview = previews.get(entry.name);
        // Previews intentionally expire across restarts. Unknown directory names
        // are never touched, and a symlink is removed without following it.
        if (!preview || now - preview.createdAt >= TTL_MS) await discard(entry.name);
      }
      const oldest = [...previews.values()].sort((a, b) => a.createdAt - b.createdAt);
      while (previews.size >= MAX_PREVIEWS && oldest.length) await discard(oldest.shift()!.id);
    });
    return maintenance;
  };
  void cleanup().catch(error => console.error("Preview cleanup failed:", error));
  const cleanupTimer = setInterval(() => { void cleanup().catch(error => console.error("Preview cleanup failed:", error)); }, 5 * 60_000);
  cleanupTimer.unref();

  app.post("/api/previews", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Check the selected video and manual preview settings." });
    const source = state.sources.find(item => item.id === parsed.data.sourceId);
    if (!source) return res.status(404).json({ error: "The source video has expired or been removed. Upload it again." });
    const settings = parsed.data.settings;
    const audio = settings.audioId ? state.attachments.find(item => item.id === settings.audioId && item.kind === "audio") : undefined;
    const subtitle = settings.subtitleId ? state.attachments.find(item => item.id === settings.subtitleId && item.kind === "subtitle") : undefined;
    if ((settings.audioId && !audio) || (settings.subtitleId && !subtitle))
      return res.status(400).json({ error: "Attach the selected audio or subtitle file again; it is no longer available." });
    if (active) return res.status(409).json({ error: "A preview is already rendering. Wait for it to finish or cancel it first." });
    const id = randomUUID();
    active = id;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    timeout.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    try {
      await assertLinkedSourceUnchanged(source);
      const bounded = manualPreviewSettings(settings, source);
      const ownFootage = previewFootage(bounded.settings.ownFootage);
      // Attachment IDs are immutable; mtime and size also invalidate cached
      // previews if local media was replaced outside the app.
      const files = await Promise.all([source.filePath, audio?.filePath, subtitle?.filePath, ...ownFootage.map(item => item.path)]
        .filter((file): file is string => !!file)
        .map(async file => { const info = await stat(file); return [file, info.size, info.mtimeMs]; }));
      await cleanup();
      if (controller.signal.aborted) throw new Error("Preview cancelled");
      const key = createHash("sha256").update(JSON.stringify({ settings, files })).digest("hex");
      const cached = [...previews.values()].find(item => item.key === key);
      if (cached) return res.status(201).json({ id: cached.id, url: `/api/previews/${cached.id}/video`, duration: cached.duration });
      const folder = path.join(directory, id);
      const output = path.join(folder, "preview.mp4");
      await renderVideo({
        ownFootage, maximumOutputDuration: 5,
        input: source.filePath, output, settings: bounded.settings, source: bounded.source,
        audioPath: audio?.filePath, subtitlePath: subtitle?.filePath,
        motionDuration: bounded.motionDuration,
        workDir: path.join(folder, "work"), signal: controller.signal, onProgress: () => {},
      });
      const result = await probeMedia(output, controller.signal);
      if (result.duration > PREVIEW_SECONDS + 0.1 || (await stat(output)).size > 64 * 1024 * 1024)
        throw new PreviewError(422, "This preview exceeded its size limit. Try a shorter interval.");
      if (controller.signal.aborted) throw new Error("Preview cancelled");
      await rm(path.join(folder, "work"), { recursive: true, force: true });
      previews.set(id, { id, key, duration: bounded.duration, createdAt: Date.now() });
      return res.status(201).json({ id, url: `/api/previews/${id}/video`, duration: bounded.duration });
    } catch (error) {
      await discard(id).catch(() => undefined);
      if (res.destroyed) return;
      if (timedOut) return res.status(504).json({ error: "The preview took too long. Try a shorter interval or simpler effects." });
      if (error instanceof PreviewError || error instanceof ImportError) return res.status(error.status).json({ error: error.message });
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return res.status(404).json({ error: "A selected media file is no longer available. Upload it again." });
      console.error("Manual preview failed:", error);
      return res.status(422).json({ error: "The preview could not be rendered. Check the selected media and subtitle file, then try again." });
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", disconnected);
      active = undefined;
    }
  });

  app.get("/api/previews/:id/video", async (req, res, next) => {
    const id = req.params.id;
    const preview = UUID.test(id) ? previews.get(id) : undefined;
    if (!preview || Date.now() - preview.createdAt >= TTL_MS) {
      if (preview) await discard(id);
      return res.status(404).json({ error: "This preview has expired. Render a fresh preview." });
    }
    res.sendFile(path.join(directory, id, "preview.mp4"), error => {
      if (error) next(error);
    });
  });
}
import { previewFootage } from "./footage-storage.js";
