import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Attachment, RenderJob, VideoSource } from "../shared/types.js";
import { config, paths } from "./config.js";
export interface StoredSource extends VideoSource {
  filePath: string;
  thumbnailPath: string;
}
export interface StoredAttachment extends Attachment {
  filePath: string;
  createdAt: string;
}
export interface StoredJob extends RenderJob {
  outputPath: string;
  captionPath?: string;
}
interface State {
  sources: StoredSource[];
  attachments: StoredAttachment[];
  jobs: StoredJob[];
}
export const state: State = { sources: [], attachments: [], jobs: [] };
let writes = Promise.resolve();
export async function initStore() {
  await Promise.all(
    Object.values(paths).map((dir) => mkdir(dir, { recursive: true })),
  );
  try {
    const saved = JSON.parse(
      await readFile(path.join(config.dataDir, "state.json"), "utf8"),
    ) as State;
    if (
      !Array.isArray(saved.sources) ||
      !Array.isArray(saved.jobs) ||
      !Array.isArray(saved.attachments)
    )
      throw new Error("Invalid state file");
    Object.assign(state, saved);
    for (const job of state.jobs)
      if (job.status === "processing") {
        job.status = "failed";
        job.error =
          "The app stopped during this render. Retry to start it again.";
        job.finishedAt = new Date().toISOString();
        job.phase = undefined;
        await Promise.all([
          rm(path.join(paths.work, job.id), { recursive: true, force: true }),
          rm(job.outputPath, { force: true }),
          ...(job.captionPath ? [rm(job.captionPath, { force: true })] : []),
        ]);
        delete job.captionPath;
        delete job.captionUrl;
        delete job.downloadUrl;
      }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Unable to read saved workspace. Keep a backup of data/state.json before repairing it.",
        { cause: error },
      );
  }
  await saveStore();
}
export function saveStore() {
  const contents = JSON.stringify(state);
  writes = writes
    .catch(() => undefined)
    .then(async () => {
      const destination = path.join(config.dataDir, "state.json");
      await writeFile(`${destination}.tmp`, contents, { mode: 0o600 });
      await rename(`${destination}.tmp`, destination);
    });
  return writes;
}
export function publicSource(source: StoredSource): VideoSource {
  const {
    filePath: _filePath,
    thumbnailPath: _thumbnailPath,
    ...value
  } = source;
  return value;
}
export function publicJob(job: StoredJob): RenderJob {
  const { outputPath: _outputPath, captionPath: _captionPath, ...value } = job;
  return value;
}
