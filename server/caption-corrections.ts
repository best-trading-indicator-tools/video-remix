import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredJob } from './store.js';
import { canonicalSubtitles } from './engine.js';
import { parseCaptionCues } from './edit-plan.js';

/** Run after automatic repairs. Saved plans consume rules so retries/revisions cannot apply them twice. */
export async function prepareCaptionCorrections(job: StoredJob, subtitlePath: string | undefined, workDir: string) {
  if (!subtitlePath || !job.settings.captionCorrections?.length) return { subtitlePath, applied: false };
  const corrected = await canonicalSubtitles(subtitlePath, undefined, job.settings.captionCorrections);
  const correctedPath = path.join(workDir, 'corrected-captions.srt');
  await writeFile(correctedPath, corrected, 'utf8');
  if (job.editPlan) {
    job.editPlan.captions = parseCaptionCues(corrected);
    job.editPlan.captionMode = job.editPlan.captions.length ? 'generated' : 'off';
    job.editPlan.settings.captionCorrections = [];
    job.settings.captionCorrections = [];
  }
  (job.notes ??= []).push('Bulk caption corrections applied to added captions. Source speech and timing are unchanged.');
  return { subtitlePath: corrected.trim() ? correctedPath : undefined, applied: true };
}
