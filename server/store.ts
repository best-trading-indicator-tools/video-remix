import { mkdir, rm } from "node:fs/promises";
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
import { fingerprintFile, historyEntry, upsertHistory, relatedHistory } from "./history.js";
import { migrateLegacyPlanResolutions } from "./plan-migrations.js";
import { retainHistoryThumbnail } from "./history-thumbnails.js";
import { recoverInterruptedJob } from "./job-recovery.js";
import type { VisualIdentity } from "../shared/visual-identity.js";
import { visualIdentity } from "./visual-identity.js";
import { WorkspaceDatabase, type HistoryFilter } from "./database.js";
export interface StoredSource extends VideoSource {
  picture?: VisualIdentity;
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
  outputPicture?: VisualIdentity;
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
let database: WorkspaceDatabase | undefined;
let replacementHistory: ExportHistoryEntry[] | undefined;
Object.defineProperty(state, "history", {
  get: () => replacementHistory ?? (database ? [...database.history()] : []),
  set: (entries: ExportHistoryEntry[]) => { replacementHistory = entries; },
  enumerable: true,
});
export function historyRecords(filter: HistoryFilter = {}): ExportHistoryEntry[] {
  if (!replacementHistory && database) return [...database.history(filter)];
  return (replacementHistory || []).filter(entry =>
    (filter.id === undefined || entry.id === filter.id) &&
    (filter.jobId === undefined || entry.jobId === filter.jobId) &&
    (filter.fingerprint === undefined || entry.sourceFingerprint === filter.fingerprint));
}
export function* iterateHistory() {
  if (replacementHistory) yield* replacementHistory;
  else if (database) yield* database.history();
}
export async function reconcileHistory(entry: ExportHistoryEntry) {
  const previous = historyRecords({ jobId: entry.jobId });
  await saveStore(upsertHistory(previous, entry));
}
export async function initStore() {
  await Promise.all(Object.values(paths).map((dir) => mkdir(dir, { recursive: true })));
  database?.close();
  database = new WorkspaceDatabase(path.join(config.dataDir, "remixer.sqlite"));
  replacementHistory = undefined;
  try {
    await database.initialize();
    Object.assign(state, database.loadActive());
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
    database.close(); database = undefined;
    throw new Error("Unable to open saved workspace. Preserve remixer.sqlite and state.json before repairing it.", { cause: error });
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
    source.picture ??= await visualIdentity(source.filePath, source.duration);
    for (const job of completed) {
      job.outputPicture ??= historyRecords({ jobId: job.id })[0]?.outputPicture ?? await visualIdentity(job.outputPath, job.summary?.outputDuration ?? 0);
      const entry = historyEntry(source, job);
      if (entry) await reconcileHistory(entry);
    }
  }
  // Backfill available legacy exports before startup retention removes them.
  // Two workers bound local media work; retained frames need no source/video file.
  const completedJobs = new Map(state.jobs.filter(job => job.status === "completed").map(job => [job.id, job]));
  for (const entry of iterateHistory()) {
    const source = state.sources.find(item => item.fingerprint === entry.sourceFingerprint);
    const cut = entry.cuts[0];
    const sourceFrame = source && cut && cut.end <= source.duration
      ? { filePath: source.filePath, start: cut.start, end: cut.end, fileSignature: source.fileSignature } : undefined;
    const thumbnail = await retainHistoryThumbnail(entry, completedJobs.get(entry.jobId)?.outputPath, undefined, sourceFrame);
    const before = JSON.stringify([entry.thumbnailUrl, entry.thumbnailKind]);
    if (thumbnail) { entry.thumbnailUrl = thumbnail.url; entry.thumbnailKind = thumbnail.kind; }
    else { delete entry.thumbnailUrl; delete entry.thumbnailKind; }
    if (before !== JSON.stringify([entry.thumbnailUrl, entry.thumbnailKind])) await saveStore([entry]);
  }
  await saveStore();
}
export async function saveStore(history: ExportHistoryEntry[] = []) {
  if (!database) throw new Error("Workspace database is not initialized");
  database.save(state, replacementHistory ? [...replacementHistory.filter(entry => !history.some(update => update.id === entry.id)), ...history] : history, replacementHistory !== undefined);
  replacementHistory = undefined;
}
export function publicSource(source: StoredSource): VideoSource {
  const {
    filePath: _filePath,
    thumbnailPath: _thumbnailPath,
    fileSignature: _fileSignature,
    picture: _picture,
    ...value
  } = source;
  return { ...value, ...(source.fingerprint ? { previousExports: state.history.filter(entry => entry.sourceFingerprint === source.fingerprint).length,
    similarExports: relatedHistory(state.history, source).filter(entry => entry.match?.kind !== "exact").length } : {}) };
}
export function publicJob(job: StoredJob): RenderJob {
  const { outputPicture: _outputPicture, outputPath: _outputPath, captionPath: _captionPath, footageFiles: _footageFiles,
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
