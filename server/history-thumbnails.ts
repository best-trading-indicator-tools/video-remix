import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ExportHistoryEntry } from "../shared/types.js";
import { paths } from "./config.js";
import { createThumbnail } from "./engine.js";

export interface HistoryThumbnail { url: string; kind: "export" | "source" }
interface SourceFrame {
  filePath: string;
  start: number;
  end: number;
  fileSignature?: { dev: number; ino: number; size: number; mtimeMs: number };
}

export const historyThumbnailUrl = (id: string) => `/api/history/${encodeURIComponent(id)}/thumbnail`;
// Treat even legacy ledger IDs as opaque identifiers, never path segments.
export const historyThumbnailPath = (id: string) => path.join(paths.historyThumbnails,
  `${createHash("sha256").update(id).digest("hex")}.jpg`);

export async function historyThumbnailExists(id: string): Promise<boolean> {
  try {
    const info = await lstat(historyThumbnailPath(id));
    return info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024;
  } catch { return false; }
}

/** Retain a small frame of the actual export. Thumbnail failures never fail a render. */
export async function retainHistoryThumbnail(entry: Pick<ExportHistoryEntry, "id" | "outputDuration" | "thumbnailKind">,
  outputPath?: string, signal?: AbortSignal, source?: SourceFrame): Promise<HistoryThumbnail | undefined> {
  let temporary: string | undefined;
  try {
    signal?.throwIfAborted();
    if (await historyThumbnailExists(entry.id)) return { url: historyThumbnailUrl(entry.id), kind: entry.thumbnailKind ?? "export" };
    if (!Number.isFinite(entry.outputDuration) || entry.outputDuration <= 0) return;
    const output = outputPath ? await lstat(outputPath).catch(() => undefined) : undefined;
    let input = output?.isFile() && output.size ? outputPath : undefined;
    let seek = Math.min(1, entry.outputDuration / 4);
    let kind: HistoryThumbnail["kind"] = "export";
    if (!input && source && Number.isFinite(source.start) && Number.isFinite(source.end) && source.start >= 0 && source.end > source.start) {
      // Linked-source signatures are captured from the resolved original path.
      const info = await stat(await realpath(source.filePath));
      if (!info.isFile() || !info.size || (source.fileSignature &&
        (["dev", "ino", "size", "mtimeMs"] as const).some(key => info[key] !== source.fileSignature![key]))) return;
      input = source.filePath;
      seek = source.start + Math.min(1, (source.end - source.start) / 4);
      kind = "source";
    }
    if (!input) return;
    await mkdir(paths.historyThumbnails, { recursive: true });
    const destination = historyThumbnailPath(entry.id);
    temporary = path.join(paths.historyThumbnails, `${randomUUID()}.tmp.jpg`);
    // Seek into the completed cut, past its first frame, including for very short exports.
    await createThumbnail(input, temporary, signal, seek);
    const preview = await lstat(temporary);
    if (!preview.isFile() || !preview.size || preview.size > 2 * 1024 * 1024) return;
    signal?.throwIfAborted();
    await rename(temporary, destination);
    return { url: historyThumbnailUrl(entry.id), kind };
  } catch { return undefined; }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); }
}
