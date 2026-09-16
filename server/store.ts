import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Attachment,
  BrollAsset,
  RenderJob,
  VideoSource,
  EditPlan,
  Transcript,
  ExportHistoryEntry,
} from "../shared/types.js";
import { config, paths } from "./config.js";
import { fingerprintFile, historyEntry, upsertHistory } from "./history.js";
import { migrateLegacyPlanResolutions } from "./plan-migrations.js";
import { retainHistoryThumbnail } from "./history-thumbnails.js";
import { recoverInterruptedJob } from "./job-recovery.js";
export interface StoredSource extends VideoSource {
  filePath: string;
  thumbnailPath: string;
  fileSignature?: { dev: number; ino: number; size: number; mtimeMs: number };
}
export interface StoredBroll extends StoredSource {
  tags: string[];
  attribution?: BrollAsset["attribution"];
  selection?: BrollAsset["selection"];
  stock?: BrollAsset["stock"];
}
export interface StoredAttachment extends Attachment {
  filePath: string;
  createdAt: string;
}
export interface StoredJob extends RenderJob {
  footageFiles?: Record<string, { filename: string; name: string; duration: number; hasAudio: boolean }>;
  /** An explicit retry of a skipped Auto version can reuse this batch's footage. */
  allowRepeatedFootage?: boolean;
  refreshBroll?: boolean;
  preserveBroll?: boolean;
  outputPath: string;
  captionPath?: string;
  editPlan?: EditPlan;
  planFiles?: Record<string, string>;
  sourceTranscript?: Transcript;
  brollCandidates?: StoredBroll[];
}
interface State {
  sources: StoredSource[];
  attachments: StoredAttachment[];
  jobs: StoredJob[];
  broll: StoredBroll[];
  history: ExportHistoryEntry[];
}
export const state: State = {
  sources: [],
  attachments: [],
  jobs: [],
  broll: [],
  history: [],
};
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
    state.broll = Array.isArray(saved.broll) ? saved.broll : [];
    state.history = Array.isArray(saved.history) ? saved.history : [];
    for (const job of state.jobs)
      if (job.status === "processing") {
        await Promise.all([
          rm(path.join(paths.work, job.id), { recursive: true, force: true }),
          rm(job.outputPath, { force: true }),
          ...(job.captionPath ? [rm(job.captionPath, { force: true })] : []),
        ]);
        delete job.captionPath;
        delete job.captionUrl;
        delete job.downloadUrl;
        delete job.outputSize;
        recoverInterruptedJob(job);
      }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Unable to read saved workspace. Keep a backup of data/state.json before repairing it.",
        { cause: error },
      );
  }
  await migrateLegacyPlanResolutions(state.sources, state.jobs);
  // Migrate still-available exports before retention cleanup removes their files.
  for (const source of state.sources) {
    const completed = state.jobs.filter(job => job.sourceId === source.id && job.status === "completed");
    if (!completed.length) continue;
    if (!source.fingerprint) {
      try { source.fingerprint = await fingerprintFile(source.filePath); }
      catch { continue; } // A missing legacy source cannot be identified reliably.
    }
    for (const job of completed) {
      const entry = historyEntry(source, job);
      if (entry) state.history = upsertHistory(state.history, entry);
    }
  }
  // Backfill available legacy exports before startup retention removes them.
  // Two workers bound local media work; retained frames need no source/video file.
  const completedJobs = new Map(state.jobs.filter(job => job.status === "completed").map(job => [job.id, job]));
  let nextPreview = 0;
  await Promise.all(Array.from({ length: Math.min(2, state.history.length) }, async () => {
    while (nextPreview < state.history.length) {
      const entry = state.history[nextPreview++]!;
      const source = state.sources.find(item => item.fingerprint === entry.sourceFingerprint);
      const cut = entry.cuts[0];
      const sourceFrame = source && cut && cut.end <= source.duration
        ? { filePath: source.filePath, start: cut.start, end: cut.end, fileSignature: source.fileSignature } : undefined;
      const thumbnail = await retainHistoryThumbnail(entry, completedJobs.get(entry.jobId)?.outputPath, undefined, sourceFrame);
      if (thumbnail) { entry.thumbnailUrl = thumbnail.url; entry.thumbnailKind = thumbnail.kind; }
      else { delete entry.thumbnailUrl; delete entry.thumbnailKind; }
    }
  }));
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
    fileSignature: _fileSignature,
    ...value
  } = source;
  return { ...value, ...(source.fingerprint ? { previousExports: state.history.filter(entry => entry.sourceFingerprint === source.fingerprint).length } : {}) };
}
export function publicJob(job: StoredJob): RenderJob {
  const { outputPath: _outputPath, captionPath: _captionPath, footageFiles: _footageFiles,
    editPlan: _editPlan, planFiles: _planFiles, sourceTranscript: _transcript,
    brollCandidates: _candidates, refreshBroll: _refreshBroll, preserveBroll: _preserveBroll,
    allowRepeatedFootage: _allowRepeatedFootage, ...value } = job;
  return { ...value, ...(job.footageFiles ? { footageAssets: Object.entries(job.footageFiles).map(([id, media]) => ({ id, name: media.name, duration: media.duration, hasAudio: media.hasAudio, url: `/api/jobs/${job.id}/footage/${id}` })) } : {}), ...(job.editPlan ? { editable: true, revision: job.editPlan.revision } : {}) };
}
export function publicBroll(asset: StoredBroll): BrollAsset {
  const {
    filePath: _filePath,
    thumbnailPath: _thumbnailPath,
    ...value
  } = asset;
  return value;
}
