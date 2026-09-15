import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { ZipArchive } from "archiver";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import {
  checkBinaries,
  createThumbnail,
  probeAudio,
  probeMedia,
} from "./engine.js";
import { autoBatchSchema, batchSchema } from "./schema.js";
import { getAutoCapabilities } from "./auto.js";
import {
  publicJob,
  publicBroll,
  publicSource,
  saveStore,
  state,
  type StoredJob,
  type StoredSource,
  type StoredBroll,
} from "./store.js";
import { cancelJob, isActive, isRunning, pumpQueue } from "./queue.js";
import { DEFAULT_SETTINGS, randomizeSettings } from "../shared/types.js";
import { applyEditPlanChanges, editPlanChangesSchema } from "./edit-plan.js";
import { clonePlanFiles, planMediaPath, publicEditPlan } from "./plan-storage.js";
import { stockBrollConfigured } from "./stock-broll.js";
import { brollAIConfigured } from "./broll-ai.js";
import { fingerprintFile, publicationChangesSchema } from "./history.js";
import { correctionRecord, measurementsCsv, measurementsSchema, measurementSummary } from "./measurements.js";
import { installManualPreviewRoutes } from "./manual-preview.js";
import { assertLinkedSourceUnchanged, ImportError, installMediaImportRoutes } from "./media-imports.js";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const videoExtensions = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".mpeg",
  ".mpg",
]);
const audioExtensions = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
]);
const nameOf = (value: string) =>
  path
    .basename(value.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 180) || "video";
const diskStorage = (destination: string) =>
  multer.diskStorage({
    destination,
    filename: (_req, file, cb) =>
      cb(
        null,
        `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
      ),
  });
const videoUpload = multer({
  storage: diskStorage(paths.uploads),
  defParamCharset: "utf8",
  limits: { fileSize: config.maxFileSize, files: config.maxFiles, fields: 0 },
  fileFilter: (_req, file, cb) => {
    if (!videoExtensions.has(path.extname(file.originalname).toLowerCase()))
      return cb(
        new HttpError(
          400,
          "Choose MP4, MOV, M4V, WebM, MKV, AVI, or MPEG video files.",
        ),
      );
    cb(null, true);
  },
}).array("videos", config.maxFiles);
const attachmentUpload = multer({
  storage: diskStorage(paths.attachments),
  defParamCharset: "utf8",
  limits: {
    fileSize: Math.min(config.maxFileSize, 100 * 1024 * 1024),
    files: 1,
    fields: 1,
    fieldSize: 20,
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!audioExtensions.has(extension) && extension !== ".srt")
      return cb(
        new HttpError(
          400,
          "Choose an SRT subtitle file or MP3, WAV, M4A, AAC, OGG, or FLAC audio.",
        ),
      );
    cb(null, true);
  },
}).single("file");
let inflightUploads = 0;
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
    if (!["0.0.0.0", "::"].includes(config.host)) hosts.add(config.host);
    if (!hosts.has(req.hostname))
      return res
        .status(403)
        .json({ error: "Use the local app address to access Remix Studio." });
    const origin = req.get("origin");
    if (origin) {
      try {
        if (!hosts.has(new URL(origin).hostname)) throw new Error("Origin");
      } catch {
        return res.status(403).json({
          error: "This request did not come from your local workspace.",
        });
      }
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  installMediaImportRoutes(app);
  installManualPreviewRoutes(app);
  let binaries = checkBinaries();
  app.get("/api/health", async (_req, res) => {
    let tools = await binaries;
    if (!tools.ffmpeg || !tools.ffprobe) {
      binaries = checkBinaries();
      tools = await binaries;
    }
    res.json({
      ok: tools.ffmpeg && tools.ffprobe,
      ...tools,
      maxFileSize: config.maxFileSize,
      maxLargeFileSize: config.maxLargeFileSize,
      importChunkSize: config.importChunkSize,
      maxFiles: config.maxFiles,
      concurrency: config.concurrency,
      retentionHours: config.retentionMs / 3600000,
    });
  });
  app.get("/api/sources", (_req, res) =>
    res.json({ sources: state.sources.map(publicSource) }),
  );
  const publicHistory = () => state.history.map(entry => ({ ...entry,
    available: state.jobs.some(job => job.id === entry.jobId && job.status === "completed"),
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  app.get("/api/history", (_req, res) => res.json({ entries: publicHistory() }));
  app.get("/api/measurements", (_req, res) => res.json(measurementSummary(state.history)));
  app.get("/api/measurements/export", (req, res) => {
    if (req.query.format === "csv") {
      res.type("text/csv").attachment("remix-measurements.csv").send(measurementsCsv(state.history));
    } else if (req.query.format === "json" || req.query.format === undefined) {
      res.type("application/json").attachment("remix-measurements.json").send(JSON.stringify({ version: 1,
        exportedAt: new Date().toISOString(), ...measurementSummary(state.history), entries: publicHistory() }, null, 2));
    } else throw new HttpError(400, "Choose JSON or CSV for the measurements export.");
  });
  app.patch("/api/history/:id/measurements", async (req, res) => {
    const entry = state.history.find(item => item.id === req.params.id);
    if (!entry) throw new HttpError(404, "History entry not found.");
    const parsed = measurementsSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Check the review counts, time and platform metrics. Leave unknown values blank.");
    entry.measurements = parsed.data;
    await saveStore();
    res.json(publicHistory().find(item => item.id === entry.id));
  });
  app.get("/api/sources/:id/history", (req, res) => {
    const source = state.sources.find(item => item.id === req.params.id);
    if (!source) throw new HttpError(404, "Source video not found.");
    res.json({ entries: publicHistory().filter(entry => entry.sourceFingerprint === source.fingerprint) });
  });
  app.patch("/api/history/:id", async (req, res) => {
    const entry = state.history.find(item => item.id === req.params.id);
    if (!entry) throw new HttpError(404, "History entry not found.");
    const parsed = publicationChangesSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Use a valid publication date and an HTTPS link on the selected platform.");
    entry.publications = parsed.data.publications;
    await saveStore();
    res.json(publicHistory().find(item => item.id === entry.id));
  });
  app.get("/api/broll", (_req, res) =>
    res.json({ assets: state.broll.map(publicBroll) }),
  );
  app.patch("/api/broll/:id", async (req, res) => {
    const asset = state.broll.find((item) => item.id === req.params.id);
    if (!asset) throw new HttpError(404, "B-roll clip not found.");
    const parsed = z
      .object({ tags: z.array(z.string().trim().min(1).max(60)).max(12) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        400,
        "Use up to 12 descriptive tags, each shorter than 60 characters.",
      );
    asset.tags = [...new Set(parsed.data.tags)];
    await saveStore();
    res.json(publicBroll(asset));
  });
  app.get("/api/broll/:id/video", (req, res, next) => {
    const asset = state.broll.find((item) => item.id === req.params.id);
    if (!asset) throw new HttpError(404, "B-roll clip not found.");
    res.sendFile(asset.filePath, (error) => {
      if (error) next(error);
    });
  });
  app.get("/api/broll/:id/thumbnail", (req, res, next) => {
    const asset = state.broll.find((item) => item.id === req.params.id);
    if (!asset) throw new HttpError(404, "B-roll clip not found.");
    res.sendFile(asset.thumbnailPath, (error) => {
      if (error) next(error);
    });
  });
  app.delete("/api/broll/:id", async (req, res) => {
    const asset = state.broll.find((item) => item.id === req.params.id);
    if (!asset) throw new HttpError(404, "B-roll clip not found.");
    if (
      state.jobs.some(
        (job) => isActive(job) && job.auto?.brollIds?.includes(asset.id),
      )
    )
      throw new HttpError(
        409,
        "Wait for edits using this B-roll clip to finish, or cancel them first.",
      );
    state.broll = state.broll.filter((item) => item.id !== asset.id);
    await saveStore();
    await Promise.all([
      rm(asset.filePath, { force: true }),
      rm(asset.thumbnailPath, { force: true }),
      rm(path.join(paths.analysis, `broll-${asset.id}.json`), { force: true }),
    ]);
    res.json({ ok: true });
  });
  app.get("/api/auto/capabilities", async (_req, res) =>
    res.json(await getAutoCapabilities()),
  );
  app.post("/api/auto/jobs", async (req, res) => {
    const parsed = autoBatchSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        400,
        `Check automatic edit options: ${parsed.error.issues
          .map((issue) => issue.message)
          .slice(0, 3)
          .join("; ")}`,
      );
    const { items } = parsed.data;
    const available = await binaries;
    if (!available.ffmpeg || !available.ffprobe)
      throw new HttpError(503, "Install FFmpeg and ffprobe before exporting.");
    // Resolve every source and library selection before adding any jobs.
    const preparedItems = items.map(({ sourceId, variants, options }) => {
      const source = state.sources.find((item) => item.id === sourceId);
      if (!source)
        throw new HttpError(
          404,
          "A source video has expired or been removed. Upload it again.",
        );
      const usesLibrary =
        options.supportingVisuals === "library" ||
        options.supportingVisuals === "both";
      const brollIds = usesLibrary
        ? [...new Set(options.brollIds ?? state.broll.map((asset) => asset.id))]
        : [];
      if (usesLibrary && !brollIds.length)
        throw new HttpError(
          400,
          "Add and select a B-roll clip, or choose animated cards instead.",
        );
      if (brollIds.some((id) => !state.broll.some((asset) => asset.id === id)))
        throw new HttpError(
          404,
          "A selected B-roll clip was removed. Choose your supporting clips again.",
        );
      return { source, variants, options: { ...options, brollIds } };
    });
    const jobCount = preparedItems.reduce(
      (sum, item) => sum + item.variants,
      0,
    );
    if (state.jobs.filter(isActive).length + jobCount > 300)
      throw new HttpError(
        429,
        "Your render queue is full. Wait for some exports to finish.",
      );
    const batchId = randomUUID();
    const jobs: StoredJob[] = preparedItems.flatMap(
      ({ source, variants, options }) =>
        Array.from({ length: variants }, (_, index) => {
          const id = randomUUID();
          return {
            id,
            batchId,
            sourceId: source.id,
            sourceName: source.name,
            variant: index + 1,
            auto: { ...options, brollIds: [...options.brollIds] },
            settings: { ...DEFAULT_SETTINGS },
            status: "queued",
            phase: "Waiting to edit",
            progress: 0,
            createdAt: new Date().toISOString(),
            outputPath: path.join(paths.outputs, `${id}.mp4`),
          };
        }),
    );
    state.jobs.push(...jobs);
    await saveStore();
    res.status(201).json({ batchId, jobs: jobs.map(publicJob) });
    pumpQueue();
  });
  app.post(["/api/sources", "/api/broll"], (req, res, next) => {
    const isBroll = req.path === "/api/broll";
    if (inflightUploads >= 2)
      return next(
        new HttpError(
          429,
          "Two uploads are already in progress. Wait for one to finish.",
        ),
      );
    inflightUploads++;
    let released = false;
    const release = () => {
      if (!released) {
        inflightUploads--;
        released = true;
      }
    };
    res.once("close", release);
    videoUpload(req, res, (error) => {
      if (error) {
        release();
        return next(error);
      }
      void (async () => {
        const files = (req.files as Express.Multer.File[]) || [];
        if (!files.length)
          throw new HttpError(400, "Choose at least one video to upload.");
        const sources: StoredSource[] = [];
        const errors: { name: string; error: string }[] = [];
        for (const file of files) {
          const id = randomUUID();
          const thumbnailPath = path.join(paths.thumbnails, `${id}.jpg`);
          try {
            if (
              isBroll ? state.broll.length >= 100 : state.sources.length >= 200
            )
              throw new Error(
                isBroll
                  ? "Your B-roll library has 100 clips. Remove some before uploading more."
                  : "Your workspace has 200 videos. Remove some before uploading more.",
              );
            const media = await probeMedia(file.path);
            if (media.duration > 86400)
              throw new Error("Choose a video shorter than 24 hours.");
            await createThumbnail(file.path, thumbnailPath);
            const source: StoredSource = {
              id,
              name: nameOf(file.originalname),
              size: file.size,
              ...(!isBroll ? { fingerprint: await fingerprintFile(file.path) } : {}),
              ...media,
              createdAt: new Date().toISOString(),
              filePath: file.path,
              thumbnailPath,
              url: `/api/${isBroll ? "broll" : "sources"}/${id}/video`,
              thumbnailUrl: `/api/${isBroll ? "broll" : "sources"}/${id}/thumbnail`,
            };
            sources.push(source);
            if (isBroll) {
              const asset = Object.assign(source, { tags: [] as string[] });
              state.broll.push(asset);
            } else state.sources.push(source);
          } catch (error) {
            await Promise.all([
              rm(file.path, { force: true }),
              rm(thumbnailPath, { force: true }),
            ]);
            errors.push({
              name: nameOf(file.originalname),
              error:
                error instanceof Error
                  ? error.message
                      .replaceAll(file.path, nameOf(file.originalname))
                      .replaceAll(config.dataDir, "[local workspace]")
                      .slice(-1000)
                  : "This video could not be read.",
            });
          }
        }
        await saveStore();
        res.status(sources.length ? 201 : 400).json({
          ...(isBroll
            ? { assets: (sources as StoredBroll[]).map(publicBroll) }
            : { sources: sources.map(publicSource) }),
          errors,
          ...(sources.length
            ? {}
            : {
                error: errors
                  .map((item) => `${item.name}: ${item.error}`)
                  .join(" "),
              }),
        });
      })()
        .catch(next)
        .finally(release);
    });
  });
  app.get("/api/sources/:id/video", async (req, res, next) => {
    const source = state.sources.find((item) => item.id === req.params.id);
    if (!source)
      throw new HttpError(404, "Video not found. It may have expired.");
    await assertLinkedSourceUnchanged(source);
    res.sendFile(source.filePath, (error) => {
      if (error) next(error);
    });
  });
  app.get("/api/sources/:id/thumbnail", (req, res, next) => {
    const source = state.sources.find((item) => item.id === req.params.id);
    if (!source) throw new HttpError(404, "Video not found.");
    res.sendFile(source.thumbnailPath, (error) => {
      if (error) next(error);
    });
  });
  app.delete("/api/sources/:id", async (req, res) => {
    const source = state.sources.find((item) => item.id === req.params.id);
    if (!source) throw new HttpError(404, "Video not found.");
    if (state.jobs.some((job) => job.sourceId === source.id && isActive(job)))
      throw new HttpError(
        409,
        "Cancel this video’s active renders before removing it.",
      );
    state.sources.splice(state.sources.indexOf(source), 1);
    await saveStore();
    await Promise.all([
      rm(source.filePath, { force: true }),
      rm(source.thumbnailPath, { force: true }),
      rm(path.join(paths.analysis, `${source.id}.json`), { force: true }),
    ]);
    res.json({ ok: true });
  });
  app.post("/api/attachments", attachmentUpload, async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, "Choose a file.");
    try {
      const kind = req.body.kind;
      const extension = path.extname(file.originalname).toLowerCase();
      if (kind === "subtitle") {
        if (extension !== ".srt" || file.size > 2 * 1024 * 1024)
          throw new HttpError(400, "Choose an SRT file smaller than 2 MB.");
        const content = await readFile(file.path, "utf8");
        if (
          content.includes("\u0000") ||
          !/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(
            content,
          )
        )
          throw new HttpError(
            400,
            "This file does not contain valid SRT subtitle timestamps.",
          );
      } else if (kind === "audio") {
        if (!audioExtensions.has(extension))
          throw new HttpError(400, "Choose a supported audio file.");
        await probeAudio(file.path);
      } else
        throw new HttpError(
          400,
          "Choose audio or subtitle as the attachment type.",
        );
      const attachment = {
        id: randomUUID(),
        name: nameOf(file.originalname),
        kind: kind as "audio" | "subtitle",
        filePath: file.path,
        createdAt: new Date().toISOString(),
      };
      state.attachments.push(attachment);
      await saveStore();
      res.status(201).json({
        id: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
      });
    } catch (error) {
      await rm(file.path, { force: true });
      throw error;
    }
  });
  app.get("/api/jobs", (_req, res) =>
    res.json({ jobs: state.jobs.map(publicJob).reverse() }),
  );
  app.get("/api/jobs/:id/plan", (req, res) => {
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job?.editPlan) throw new HttpError(404, "This export has no saved editable plan. Create a new Auto edit first.");
    res.json(publicEditPlan(job));
  });
  app.get("/api/jobs/:id/plan/media/:mediaId", (req, res, next) => {
    const job = state.jobs.find(item => item.id === req.params.id);
    if (!job?.editPlan?.media.some(item => item.id === req.params.mediaId))
      throw new HttpError(404, "Saved footage is unavailable.");
    res.sendFile(planMediaPath(job, req.params.mediaId), error => { if (error) next(error); });
  });
  app.post("/api/jobs/:id/revisions", async (req, res) => {
    const parent = state.jobs.find(item => item.id === req.params.id);
    if (!parent?.editPlan) throw new HttpError(404, "This export has no saved editable plan.");
    if (isActive(parent) || isRunning(parent.id)) throw new HttpError(409, "Wait for this export to finish before editing it.");
    if (!state.sources.some(item => item.id === parent.sourceId))
      throw new HttpError(404, "The source has expired. Upload it again to make a new edit.");
    if (state.jobs.filter(isActive).length >= 300) throw new HttpError(429, "Your render queue is full.");
    const parsed = editPlanChangesSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Check the edited captions, cut times and footage choices.");
    if (parsed.data.revision !== parent.editPlan.revision)
      throw new HttpError(409, "This edit has changed. Reload the saved plan.");
    if (parsed.data.refreshBroll && parent.auto?.supportingVisuals !== "stock")
      throw new HttpError(400, "New stock searches are available for Auto edits made with stock B-roll.");
    if (parsed.data.refreshBroll && !stockBrollConfigured())
      throw new HttpError(400, "Add a Pixabay API key in your local environment before finding B-roll again.");
    if (parsed.data.refreshBroll && parent.auto?.brollMatching === "ai" && !brollAIConfigured())
      throw new HttpError(400, "Add a DeepSeek API key in your local environment before finding AI B-roll again.");
    let plan;
    try { plan = applyEditPlanChanges(parent.editPlan, parsed.data, parent.sourceTranscript); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid edit changes."); }
    const id = randomUUID();
    const job: StoredJob = {
      id, sourceId: parent.sourceId, sourceName: parent.sourceName, batchId: parent.batchId,
      variant: parent.variant, parentJobId: parent.id, auto: parent.auto,
      status: "queued", progress: 0, createdAt: new Date().toISOString(),
      outputPath: path.join(paths.outputs, `${id}.mp4`), settings: plan.settings, editPlan: plan,
      sourceTranscript: parent.sourceTranscript,
      ...(parsed.data.refreshBroll ? { refreshBroll: true } : {}),
      notes: [parsed.data.refreshBroll
        ? "A new stock search was requested for this video. Its saved cuts, captions and narration are used."
        : "Saved footage and narration choices were kept. This revision renders only this video."],
      corrections: { ...correctionRecord(parent.editPlan, plan, parsed.data.correctionSeconds),
        ...(!parsed.data.captions ? { captionCorrections: 0 } : {}),
        ...(!parsed.data.visuals ? { brollChanges: 0 } : {}) },
      summary: parent.summary ? { ...parent.summary, title: plan.settings.hookText || parent.summary.title,
        outputDuration: plan.outputDuration, changes: [...parent.summary.changes.filter(change => !change.startsWith("Edited revision")), `Edited revision ${plan.revision}`] } : undefined,
    };
    await clonePlanFiles(parent, job);
    // File preparation may yield while another request removes the parent/source.
    if (!state.jobs.includes(parent) || !state.sources.some(item => item.id === job.sourceId)) {
      await rm(path.join(paths.plans, id), { recursive: true, force: true });
      throw new HttpError(409, "The original edit was removed. Start a new edit.");
    }
    state.jobs.push(job);
    await saveStore();
    res.status(201).json(publicJob(job));
    pumpQueue();
  });
  app.post("/api/jobs", async (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(
        400,
        `Check export settings: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .slice(0, 4)
          .join("; ")}`,
      );
    const { items, variants, randomize } = parsed.data;
    if (state.jobs.filter(isActive).length + items.length * variants > 300)
      throw new HttpError(
        429,
        "Your render queue is full. Wait for some exports to finish.",
      );
    const { ffmpeg, ffprobe } = await binaries;
    if (!ffmpeg || !ffprobe)
      throw new HttpError(
        503,
        "FFmpeg and ffprobe must be installed before exporting. See the README for setup.",
      );
    for (const item of items) {
      const source = state.sources.find(
        (source) => source.id === item.sourceId,
      );
      if (!source)
        throw new HttpError(
          404,
          "A source video has expired or been removed. Upload it again.",
        );
      const end = item.settings.trimEnd ?? source.duration;
      if (
        item.settings.segments?.some(
          (segment) => segment.end > source.duration + 0.001,
        )
      )
        throw new HttpError(
          400,
          `${source.name}: selected cuts must stay within the source video.`,
        );
      if (end > source.duration + 0.05 || item.settings.trimStart >= end - 0.05)
        throw new HttpError(
          400,
          `${source.name}: trim end must be after the start and within the video.`,
        );
      for (const [id, kind] of [
        [item.settings.audioId, "audio"],
        [item.settings.subtitleId, "subtitle"],
      ] as const) {
        if (
          id &&
          !state.attachments.some(
            (attachment) => attachment.id === id && attachment.kind === kind,
          )
        )
          throw new HttpError(
            400,
            `${source.name}: attach the ${kind} file again; it is no longer available.`,
          );
      }
    }
    const batchId = randomUUID();
    const jobs: StoredJob[] = items.flatMap((item) =>
      Array.from({ length: variants }, (_, index) => {
        const id = randomUUID();
        const source = state.sources.find(source => source.id === item.sourceId)!;
        const settings = randomize ? randomizeSettings(item.settings) : { ...item.settings };
        return {
          id,
          batchId,
          sourceId: item.sourceId,
          sourceName: source.name,
          variant: index + 1,
          settings,
          ...(item.title ? { summary: {
            title: item.title, changes: ["Timestamp selections", ...(settings.qualityCleanup ? ["Local noise cleanup and sharpening"] : [])],
            sourceDuration: source.duration,
            outputDuration: (settings.segments?.reduce((total, cut) => total + cut.end - cut.start, 0) ??
              ((settings.trimEnd ?? source.duration) - settings.trimStart)) / settings.speed,
            transcriptAvailable: false, usedAI: false, narration: false,
          } } : {}),
          status: "queued" as const,
          progress: 0,
          createdAt: new Date().toISOString(),
          outputPath: path.join(paths.outputs, `${id}.mp4`),
        };
      }),
    );
    state.jobs.push(...jobs);
    await saveStore();
    res.status(201).json({ batchId, jobs: jobs.map(publicJob) });
    pumpQueue();
  });
  app.post("/api/jobs/:id/cancel", async (req, res) => {
    const job = state.jobs.find((item) => item.id === req.params.id);
    if (!job) throw new HttpError(404, "Export not found.");
    await cancelJob(job);
    res.json(publicJob(job));
  });
  app.post("/api/jobs/:id/retry", async (req, res) => {
    const job = state.jobs.find((item) => item.id === req.params.id);
    if (!job) throw new HttpError(404, "Export not found.");
    if (!["failed", "cancelled"].includes(job.status))
      throw new HttpError(
        409,
        "Only failed or cancelled exports can be retried.",
      );
    if (isRunning(job.id))
      throw new HttpError(
        409,
        "This export is still stopping. Wait a moment before retrying.",
      );
    if (!state.sources.some((source) => source.id === job.sourceId))
      throw new HttpError(
        404,
        "The source video is no longer available. Upload it again.",
      );
    if (
      !job.editPlan && job.auto?.brollIds?.some(
        (id) => !state.broll.some((asset) => asset.id === id),
      )
    )
      throw new HttpError(
        404,
        "A B-roll clip used by this edit was removed. Start a new edit with your current library.",
      );
    if (state.jobs.filter(isActive).length >= 300)
      throw new HttpError(429, "Your render queue is full.");
    job.status = "queued";
    job.progress = 0;
    delete job.error;
    delete job.finishedAt;
    delete job.downloadUrl;
    delete job.outputSize;
    delete job.phase;
    if (!job.editPlan) {
      delete job.summary;
      delete job.notes;
    }
    delete job.captionPath;
    delete job.captionUrl;
    delete job.supportingVisuals;
    await saveStore();
    res.json(publicJob(job));
    pumpQueue();
  });
  app.get("/api/jobs/:id/download", async (req, res, next) => {
    const job = state.jobs.find((item) => item.id === req.params.id);
    if (!job || job.status !== "completed")
      throw new HttpError(404, "This export is not ready or has expired.");
    res.download(job.outputPath, outputName(job), (error) => {
      if (error) next(error);
    });
  });
  app.get("/api/jobs/:id/captions", (req, res, next) => {
    const job = state.jobs.find((item) => item.id === req.params.id);
    if (!job || job.status !== "completed" || !job.captionPath)
      throw new HttpError(404, "Captions are not available for this export.");
    res.download(
      job.captionPath,
      outputName(job).replace(/\.mp4$/, ".srt"),
      (error) => {
        if (error) next(error);
      },
    );
  });
  app.get("/api/jobs/:id/video", (req, res, next) => {
    const job = state.jobs.find((item) => item.id === req.params.id);
    if (!job || job.status !== "completed")
      throw new HttpError(404, "This export is not ready or has expired.");
    res.sendFile(job.outputPath, (error) => {
      if (error) next(error);
    });
  });
  app.get("/api/batches/:id/download", async (req, res) => {
    const jobs = state.jobs.filter(
      (item) => item.batchId === req.params.id && item.status === "completed",
    );
    if (!jobs.length)
      throw new HttpError(404, "No finished videos to download yet.");
    for (const job of jobs) await stat(job.outputPath);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    archive.on("error", (error) => {
      console.error("ZIP download failed:", error.message);
      res.destroy(error);
    });
    archive.on("warning", (error) => {
      console.error("ZIP download warning:", error.message);
      res.destroy(error);
    });
    res.attachment(`remix-batch-${req.params.id.slice(0, 8)}.zip`);
    res.on("close", () => {
      archive.abort();
    });
    archive.pipe(res);
    jobs.forEach((job, index) => {
      archive.file(job.outputPath, {
        name: `${String(index + 1).padStart(2, "0")}-${outputName(job)}`,
      });
      if (job.captionPath)
        archive.file(job.captionPath, {
          name: `${String(index + 1).padStart(2, "0")}-${outputName(job).replace(/\.mp4$/, ".srt")}`,
        });
    });
    archive.append(JSON.stringify(jobs.map(publicJob), null, 2), {
      name: "export-settings.json",
    });
    await archive.finalize();
  });
  app.delete("/api/batches/:id", async (req, res) => {
    const jobs = state.jobs.filter((job) => job.batchId === req.params.id);
    if (!jobs.length) throw new HttpError(404, "Export collection not found.");
    if (jobs.some((job) => isActive(job) || isRunning(job.id)))
      throw new HttpError(
        409,
        "Wait for these exports to finish or cancel them before clearing the collection.",
      );
    const ids = new Set(jobs.map((job) => job.id));
    state.jobs = state.jobs.filter((job) => !ids.has(job.id));
    await saveStore();
    await Promise.all(
      jobs.flatMap((job) => [
        rm(job.outputPath, { force: true }),
        rm(path.join(paths.work, job.id), { recursive: true, force: true }),
        rm(path.join(paths.plans, job.id), { recursive: true, force: true }),
        ...(job.captionPath ? [rm(job.captionPath, { force: true })] : []),
      ]),
    );
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "This API endpoint does not exist." }),
  );
  const dist = path.resolve("dist");
  app.use(express.static(dist));
  app.get("/", (_req, res, next) =>
    res.sendFile(path.join(dist, "index.html"), (error) => {
      if (error && !res.headersSent)
        res
          .status(503)
          .type("text")
          .send(
            "Start the editor with npm run dev (http://localhost:5173), or run npm run build then npm start.",
          );
      else if (error) next(error);
    }),
  );
  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      res.status(400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? `The file is too large. Videos allow up to ${config.maxFileSize / 1024 / 1024} MB; audio attachments allow up to 100 MB.`
            : `Upload could not be completed: ${error.code === "LIMIT_UNEXPECTED_FILE" || error.code === "LIMIT_FILE_COUNT" ? `choose at most ${config.maxFiles} videos at once` : error.message}.`,
      });
      return;
    }
    const status =
      error instanceof HttpError || error instanceof ImportError
        ? error.status
        : error.status === 400
          ? 400
          : error.code === "ENOENT"
            ? 404
            : 500;
    if (status === 500) console.error("Request failed:", error);
    res.status(status).json({
      error:
        status === 500
          ? "Something went wrong. Check the app terminal and try again."
          : error.message || "Request failed.",
    });
  };
  app.use(handleError);
  return app;
}
function outputName(job: StoredJob) {
  const namedShort = !job.auto && job.summary?.title;
  const stem =
    (namedShort || path.parse(job.sourceName).name)
      .replace(/[^\p{L}\p{N} _.-]/gu, "")
      .slice(0, 100) || "video";
  return `${stem}-remix-${job.variant}${namedShort ? `-${job.id.slice(0, 8)}` : ""}.mp4`;
}
