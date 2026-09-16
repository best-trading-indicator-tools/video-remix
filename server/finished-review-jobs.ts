import path from "node:path";
import { readFile } from "node:fs/promises";
import type { CaptionCue } from "../shared/types.js";
import type { StoredJob, StoredSource } from "./store.js";
import { state } from "./store.js";
import { paths } from "./config.js";
import { parseCaptionCues } from "./edit-plan.js";
import { reviewFinishedVideo, type FinishedReviewDependencies } from "./finished-review.js";
import { assertLinkedSourceUnchanged } from "./media-imports.js";

export async function reviewJobFinished(job: StoredJob, source: StoredSource | undefined, signal: AbortSignal,
  workDir: string, captions?: CaptionCue[], dependencies?: FinishedReviewDependencies) {
  let sourcePath = source?.filePath;
  if (source) try { await assertLinkedSourceUnchanged(source); }
  catch { signal.throwIfAborted(); sourcePath = undefined; }
  if (!captions) {
    captions = job.editPlan?.captions || [];
    // Manual sidecars are on the edited clock. Saved Auto cues are also pre-insert.
    if (!job.editPlan) {
      const subtitle = state.attachments.find(item => item.id === job.settings.subtitleId && item.kind === "subtitle");
      if (subtitle) try { captions = parseCaptionCues(await readFile(subtitle.filePath, "utf8")); }
      catch { /* Picture evidence can still inspect visible subtitles. */ }
    }
  }
  return reviewFinishedVideo({ output: job.outputPath, sourcePath,
    sourceDuration: source?.duration ?? job.editPlan?.sourceDuration ?? job.summary?.sourceDuration ?? (job.settings.trimEnd || 1),
    sourceFps: source?.fps ?? 30, settings: job.settings, visuals: job.supportingVisuals || [], captions,
    workDir, cacheFile: path.join(paths.plans, job.id, "finished-audio.json"), signal }, dependencies);
}
