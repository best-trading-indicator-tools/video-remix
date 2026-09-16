import { visualIdentity } from "./visual-identity.js";
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, symlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ImportSession } from "../shared/imports.js";
import { config, paths } from "./config.js";
import { createThumbnail, probeMedia } from "./engine.js";
import { fingerprintFile } from "./history.js";
import { publicSource, saveStore, state, type StoredSource } from "./store.js";

const TTL = 48 * 60 * 60 * 1000;
const MAX_SESSIONS = 30;
const DISK_RESERVE = 128 * 1024 * 1024;
const extensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpeg", ".mpg"]);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const uploadSchema = z.object({
  name: z.string().min(1).max(255), size: z.number().int().positive().max(config.maxLargeFileSize),
  lastModified: z.number().int().nonnegative(), identity: z.string().regex(/^[\da-f]{64}$/iu),
}).strict();
const signatureSchema = z.object({ dev: z.number(), ino: z.number(), size: z.number(), mtimeMs: z.number() }).strict();
const storedSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(180), size: z.number().int().positive().max(config.maxLargeFileSize),
  offset: z.number().int().nonnegative().max(config.maxLargeFileSize), kind: z.enum(["upload", "local"]),
  status: z.enum(["uploading", "processing", "completed", "failed"]), phase: z.string(),
  progress: z.number().min(0).max(100), createdAt: z.number(), updatedAt: z.number(),
  identity: z.string().regex(/^[\da-f]{64}$/iu).optional(), lastModified: z.number().optional(),
  error: z.string().optional(), signature: signatureSchema.optional(),
}).strict();
type StoredImport = z.infer<typeof storedSchema>;

export class ImportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const sessions = new Map<string, StoredImport>();
const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
const chunks = new Map<string, AbortController>();
const cancelled = new Set<string>();
let stopped = false;
let initialized = false;
let maintenance: ReturnType<typeof setInterval> | undefined;
let mutations = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutations.catch(() => undefined).then(fn);
  mutations = next.then(() => undefined, () => undefined);
  return next;
}
const folder = (id: string) => path.join(paths.imports, id);
const mediaPath = (item: StoredImport) => path.join(paths.uploads, `${item.id}${path.extname(item.name).toLowerCase()}`);
const thumbnailPath = (id: string) => path.join(paths.thumbnails, `${id}.jpg`);
function cleanName(input: string) {
  const name = path.basename(input.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 180);
  if (!extensions.has(path.extname(name).toLowerCase()))
    throw new ImportError(400, "Choose MP4, MOV, M4V, WebM, MKV, AVI, or MPEG video files.");
  return name;
}
const signatureOf = (info: NonNullable<Awaited<ReturnType<typeof stat>>>) => ({ dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), mtimeMs: Number(info.mtimeMs) });

/** Linked originals may move or change outside the app. Never render against stale metadata. */
export async function assertLinkedSourceUnchanged(source: Pick<StoredSource, "filePath" | "fileSignature">) {
  if (!source.fileSignature) return;
  try {
    const info = await stat(source.filePath);
    const actual = signatureOf(info);
    if (!info.isFile() || Object.entries(source.fileSignature).some(([key, value]) => actual[key as keyof typeof actual] !== value))
      throw new Error("Changed");
  } catch {
    throw new ImportError(409, "The linked original was moved or changed. Import it again before previewing or rendering.");
  }
}
function publicImport(item: StoredImport): ImportSession {
  const source = state.sources.find(source => source.id === item.id);
  return {
    id: item.id, name: item.name, size: item.size, offset: item.offset,
    kind: item.kind, status: item.status, phase: item.phase, progress: item.progress,
    chunkSize: config.importChunkSize, identity: item.identity, lastModified: item.lastModified,
    ...(source ? { source: publicSource(source) } : {}), ...(item.error ? { error: item.error } : {}),
  };
}
async function persist(item: StoredImport) {
  await mkdir(folder(item.id), { recursive: true });
  const destination = path.join(folder(item.id), "session.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(item), { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
async function openUpload(item: StoredImport) {
  // Opening the managed upload must never follow a substituted symbolic link.
  const handle = await open(mediaPath(item), constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new ImportError(409, "The saved upload is no longer an ordinary file. Cancel it and import the video again.");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
function safeError(error: unknown) {
  if (error instanceof ImportError) return error.message;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return "There is not enough free disk space. Free some space, then resume the import.";
  if (code === "ENOENT") return "The selected video is no longer available. Choose the file again.";
  if (code === "EACCES" || code === "EPERM") return "The app cannot read this file or write to its workspace. Check the file permissions.";
  return "This video could not be imported. Check that it is a readable video and try again.";
}
async function requireSpace(additional = 0) {
  const disk = await statfs(paths.uploads);
  const free = Number(disk.bavail) * Number(disk.bsize);
  const reserved = [...sessions.values()].reduce((total, item) => total +
    (item.kind === "upload" && item.status === "uploading" ? Math.max(0, item.size - item.offset) : 0), 0);
  if (free < reserved + additional + DISK_RESERVE)
    throw new ImportError(507, "There is not enough free disk space for this import and the remaining uploads. Free some space or cancel an unused import.");
}
function ensureCapacity() {
  if (sessions.size >= MAX_SESSIONS) throw new ImportError(429, "There are already 30 imports. Dismiss completed imports or cancel unused ones first.");
  if (state.sources.length >= 200) throw new ImportError(429, "Your workspace has 200 videos. Remove an unused source before importing another.");
}
async function discard(item: StoredImport) {
  sessions.delete(item.id);
  if (!state.sources.some(source => source.id === item.id)) {
    // A local import is a managed symlink: rm unlinks it, never the original.
    await rm(mediaPath(item), { force: true });
    await rm(thumbnailPath(item.id), { force: true });
  }
  await rm(folder(item.id), { recursive: true, force: true });
}
async function cleanup() {
  await exclusive(async () => {
    for (const item of sessions.values()) {
      if (Date.now() - item.updatedAt > TTL && !active.has(item.id) && !chunks.has(item.id)) await discard(item);
    }
  });
}
async function processImport(item: StoredImport, signal: AbortSignal) {
  let published = false;
  try {
    item.phase = "Reading video details"; item.progress = 2;
    await persist(item);
    if (item.signature) await assertLinkedSourceUnchanged({ filePath: mediaPath(item), fileSignature: item.signature });
    if (item.kind === "upload") {
      const handle = await openUpload(item);
      try {
        if ((await handle.stat()).size !== item.size) throw new ImportError(409, "The saved upload is incomplete. Cancel it and choose the video again.");
      } finally { await handle.close(); }
    }
    const media = await probeMedia(mediaPath(item), signal);
    if (media.duration > 86400) throw new ImportError(400, "Choose a video shorter than 24 hours.");
    item.phase = "Creating preview image"; item.progress = 8;
    await createThumbnail(mediaPath(item), thumbnailPath(item.id), signal);
    signal.throwIfAborted();
    item.phase = "Identifying the original for export history"; item.progress = 12;
    await persist(item);
    const fingerprint = await fingerprintFile(mediaPath(item), signal, bytes => {
      item.progress = Math.min(98, Math.round(12 + bytes / item.size * 86));
    });
    item.phase = "Checking picture similarity with earlier exports";
    await persist(item);
    const picture = await visualIdentity(mediaPath(item), media.duration, signal);
    if (item.signature) await assertLinkedSourceUnchanged({ filePath: mediaPath(item), fileSignature: item.signature });
    signal.throwIfAborted();
    await exclusive(async () => {
      signal.throwIfAborted();
      if (state.sources.length >= 200) throw new ImportError(429, "Your workspace has 200 videos. Remove an unused source before importing another.");
      const source: StoredSource = {
        id: item.id, name: item.name, size: item.size, fingerprint, picture, ...media,
        createdAt: new Date().toISOString(), filePath: mediaPath(item), thumbnailPath: thumbnailPath(item.id),
        url: `/api/sources/${item.id}/video`, thumbnailUrl: `/api/sources/${item.id}/thumbnail`,
        ...(item.signature ? { fileSignature: item.signature } : {}),
      };
      state.sources.push(source);
      try { await saveStore(); }
      catch (error) {
        state.sources = state.sources.filter(existing => existing !== source);
        throw error;
      }
      published = true;
      item.status = "completed"; item.phase = "Ready to edit"; item.progress = 100;
      item.updatedAt = Date.now(); delete item.error;
      await persist(item);
    });
  } catch (error) {
    if (signal.aborted) {
      if (!cancelled.has(item.id)) {
        item.status = "processing"; item.phase = "Waiting to resume video analysis";
        await persist(item);
      }
      return;
    }
    // If publication completed before a session metadata write failed, do not
    // discard a source which is already part of the workspace.
    if (published) {
      item.status = "completed"; item.phase = "Ready to edit"; item.progress = 100;
    } else {
      item.status = "failed"; item.phase = "Import needs attention"; item.error = safeError(error);
    }
    item.updatedAt = Date.now();
    await persist(item).catch(() => undefined);
  }
}
function pump() {
  if (stopped || !initialized) return;
  for (const item of sessions.values()) {
    if (active.size >= 2) break;
    if (item.status !== "processing" || active.has(item.id) || cancelled.has(item.id)) continue;
    const controller = new AbortController();
    const promise = processImport(item, controller.signal).finally(() => { active.delete(item.id); pump(); });
    active.set(item.id, { controller, promise });
  }
}

export async function initMediaImports() {
  await mkdir(paths.imports, { recursive: true });
  for (const entry of await readdir(paths.imports, { withFileTypes: true })) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
    try {
      const item = storedSchema.parse(JSON.parse(await readFile(path.join(folder(entry.name), "session.json"), "utf8")));
      if (item.id !== entry.name || cleanName(item.name) !== item.name || item.offset > item.size) continue;
      sessions.set(item.id, item);
      if (state.sources.some(source => source.id === item.id)) {
        item.status = "completed"; item.phase = "Ready to edit"; item.progress = 100;
      } else if (item.status !== "completed") {
        const info = await lstat(mediaPath(item));
        if (item.kind === "upload") {
          if (!info.isFile()) throw new Error("Upload is not an ordinary file");
          const handle = await openUpload(item);
          try {
            if ((await handle.stat()).size < item.offset) throw new Error("Missing committed bytes");
            // A crash after appending but before committing JSON leaves extra bytes.
            if (info.size !== item.offset) await handle.truncate(item.offset);
          } finally { await handle.close(); }
        } else if (!item.signature) throw new Error("Missing original signature");
      }
      await rm(path.join(folder(item.id), "chunk.tmp"), { force: true });
      await persist(item);
    } catch {
      const item = sessions.get(entry.name);
      if (item) {
        item.status = "failed"; item.phase = "Import needs attention";
        item.error = "The saved import is incomplete or its original file is missing. Cancel it and choose the file again.";
      }
    }
  }
  initialized = true; stopped = false;
  await cleanup();
  maintenance = setInterval(() => { void cleanup().catch(() => undefined); }, 15 * 60_000);
  maintenance.unref();
  pump();
}

export async function stopMediaImports() {
  stopped = true;
  clearInterval(maintenance);
  for (const controller of chunks.values()) controller.abort();
  for (const task of active.values()) task.controller.abort();
  await Promise.allSettled([...active.values()].map(task => task.promise));
  await mutations;
}

type Route = (req: Request, res: Response) => Promise<unknown>;
function route(fn: Route) {
  return async (req: Request, res: Response) => {
    try { await fn(req, res); }
    catch (error) {
      if (res.destroyed || res.headersSent) return;
      const status = error instanceof ImportError ? error.status : ["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException)?.code || "") ? 507 : 400;
      res.status(status).json({ error: safeError(error) });
    }
  };
}
function getSession(id: unknown) {
  const item = typeof id === "string" ? sessions.get(id) : undefined;
  if (!item) throw new ImportError(404, "This import expired or was cancelled. Start a new import.");
  if (cancelled.has(item.id)) throw new ImportError(409, "This import is being cancelled.");
  return item;
}

export function installMediaImportRoutes(app: Express) {
  app.get("/api/imports", route(async (_req, res) => {
    res.json({ imports: [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicImport) });
  }));
  app.get("/api/imports/:id", route(async (req, res) => { res.json(publicImport(getSession(req.params.id))); }));
  app.post("/api/imports", route(async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) throw new ImportError(400, "Choose a supported video within the large-file limit, with its file identity and modification date.");
    const item = await exclusive(async () => {
      ensureCapacity();
      const name = cleanName(parsed.data.name);
      await requireSpace(parsed.data.size);
      const now = Date.now();
      const value: StoredImport = { ...parsed.data, name, id: randomUUID(), offset: 0, kind: "upload",
        status: "uploading", phase: "Waiting for video data", progress: 0, createdAt: now, updatedAt: now };
      await mkdir(folder(value.id), { recursive: true });
      await writeFile(mediaPath(value), new Uint8Array(), { flag: "wx", mode: 0o600 });
      try { await persist(value); }
      catch (error) { await rm(mediaPath(value), { force: true }); throw error; }
      sessions.set(value.id, value);
      return value;
    });
    res.status(201).json(publicImport(item));
  }));
  app.post("/api/imports/local", route(async (req, res) => {
    const parsed = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(30) }).strict().safeParse(req.body);
    if (!parsed.success) throw new ImportError(400, "Enter one or more absolute paths to video files on this computer.");
    const imports: ImportSession[] = [];
    const errors: { name: string; error: string }[] = [];
    for (const candidate of parsed.data.paths) {
      try {
        const item = await exclusive(async () => {
          ensureCapacity();
          if (!path.isAbsolute(candidate) || candidate.includes("\0")) throw new ImportError(400, "Use an absolute local file path.");
          const resolved = await realpath(candidate);
          const name = cleanName(path.basename(resolved));
          const info = await stat(resolved);
          if (!info.isFile() || info.size <= 0 || info.size > config.maxLargeFileSize)
            throw new ImportError(400, "Choose a non-empty video within the large-file size limit.");
          await requireSpace();
          const now = Date.now();
          const value: StoredImport = { id: randomUUID(), name, size: info.size, offset: info.size, kind: "local",
            status: "processing", phase: "Waiting to read video", progress: 0, signature: signatureOf(info),
            createdAt: now, updatedAt: now };
          await mkdir(folder(value.id), { recursive: true });
          await symlink(resolved, mediaPath(value));
          try { await persist(value); }
          catch (error) { await rm(mediaPath(value), { force: true }); throw error; }
          sessions.set(value.id, value);
          return value;
        });
        imports.push(publicImport(item));
      } catch (error) { errors.push({ name: path.basename(candidate).slice(0, 180), error: safeError(error) }); }
    }
    res.status(imports.length ? 202 : 400).json({ imports, errors, ...(!imports.length ? { error: errors[0]?.error } : {}) });
    pump();
  }));
  app.put("/api/imports/:id", route(async (req, res) => {
    const item = getSession(req.params.id);
    if (item.kind !== "upload" || item.status !== "uploading") throw new ImportError(409, "This import is not waiting for uploaded bytes.");
    if (chunks.has(item.id)) throw new ImportError(409, "A chunk is already uploading. Check the confirmed offset before retrying.");
    const rawOffset = req.get("Upload-Offset") || "";
    if (!/^\d+$/u.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)) || Number(rawOffset) !== item.offset)
      throw new ImportError(409, "The upload offset changed. Read the current import status and resume from its confirmed offset.");
    if (req.get("Content-Type")?.split(";")[0]?.trim() !== "application/octet-stream")
      throw new ImportError(415, "Upload chunks as application/octet-stream.");
    const maximum = Math.min(config.importChunkSize, item.size - item.offset);
    const declared = req.get("Content-Length") === undefined ? undefined : Number(req.get("Content-Length"));
    if (maximum <= 0 || (declared !== undefined && (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximum)))
      throw new ImportError(400, "This chunk exceeds the remaining file size or the 8 MiB chunk limit.");
    const controller = new AbortController();
    chunks.set(item.id, controller);
    const chunkPath = path.join(folder(item.id), "chunk.tmp");
    const previous = item.offset;
    let appended = false;
    let destination: FileHandle | undefined;
    let received = 0;
    try {
      await requireSpace(config.importChunkSize);
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maximum) callback(new ImportError(400, "The upload chunk is larger than allowed."));
        else callback(null, chunk);
      } });
      await pipeline(req, bounded, createWriteStream(chunkPath, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      if (!received || (declared !== undefined && received !== declared)) throw new ImportError(400, "The chunk was incomplete. Resume from the confirmed offset.");
      controller.signal.throwIfAborted();
      destination = await openUpload(item);
      if ((await destination.stat()).size !== previous) throw new ImportError(409, "The saved upload size changed. Cancel this import and choose the file again.");
      appended = true;
      await pipeline(createReadStream(chunkPath), createWriteStream(mediaPath(item), { fd: destination.fd, autoClose: false, start: previous }), { signal: controller.signal });
      await destination.sync();
      controller.signal.throwIfAborted();
      const committed = { ...item, offset: previous + received, updatedAt: Date.now(),
        phase: previous + received === item.size ? "Upload complete; ready to analyze" : "Uploading video" };
      await persist(committed);
      Object.assign(item, committed);
    } catch (error) {
      item.offset = previous;
      if (appended) await destination?.truncate(previous).catch(() => undefined);
      throw error;
    } finally {
      await rm(chunkPath, { force: true }).catch(() => undefined);
      await destination?.close().catch(() => undefined);
      chunks.delete(item.id);
    }
    // The response acknowledges both durable bytes and a released chunk slot.
    // A fast client may send its next chunk or finish immediately after receipt.
    res.json(publicImport(item));
  }));
  app.post("/api/imports/:id/finish", route(async (req, res) => {
    const item = await exclusive(async () => {
      const current = getSession(req.params.id);
      if (chunks.has(current.id)) throw new ImportError(409, "Wait for the current chunk to finish before processing this video.");
      if (current.status === "completed" || current.status === "processing") return current;
      if (current.offset !== current.size) throw new ImportError(409, "Finish uploading the video before starting its analysis.");
      const committed = { ...current, status: "processing" as const, phase: "Waiting to read video", progress: 0,
        updatedAt: Date.now(), error: undefined };
      await persist(committed);
      Object.assign(current, committed);
      return current;
    });
    res.status(item.status === "completed" ? 200 : 202).json(publicImport(item));
    pump();
  }));
  app.delete("/api/imports/:id", route(async (req, res) => {
    const item = getSession(req.params.id);
    cancelled.add(item.id);
    chunks.get(item.id)?.abort();
    active.get(item.id)?.controller.abort();
    await active.get(item.id)?.promise;
    // A chunk may still be rolling back its append. Let it finish before unlinking.
    while (chunks.has(item.id)) await new Promise(resolve => setTimeout(resolve, 10));
    await exclusive(() => discard(item));
    cancelled.delete(item.id);
    res.json({ ok: true });
  }));
}
