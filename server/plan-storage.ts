import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EditPlan, EditPlanMedia, Transcript } from "../shared/types.js";
import { paths } from "./config.js";
import { captionCuesSrt, parseCaptionCues } from "./edit-plan.js";
import type { StoredJob, StoredSource } from "./store.js";
import type { SupportingVisual } from "./visuals.js";

export function planMediaPath(job: StoredJob, mediaId: string): string {
  const file = job.planFiles?.[mediaId];
  if (!file || file !== path.basename(file) || !job.editPlan?.media.some(item => item.id === mediaId))
    throw new Error("Saved media is unavailable for this edit.");
  return path.join(paths.plans, job.id, file);
}

async function retainFile(source: string, destination: string) {
  // Hard links preserve immutable downloaded footage through work cleanup and
  // keep a revision from duplicating its parent's media on the same disk.
  try { await link(source, destination); }
  catch { await copyFile(source, destination); }
}

export function publicEditPlan(job: StoredJob): EditPlan {
  if (!job.editPlan) throw new Error("This export has no saved edit plan.");
  return { ...structuredClone(job.editPlan), media: job.editPlan.media.map(item => ({
    ...item, url: `/api/jobs/${job.id}/plan/media/${item.id}`,
  })) };
}

export async function captureEditPlan({ job, source, visuals, audioPath, subtitlePath, sourceTranscript, signal }: {
  job: StoredJob; source: StoredSource; visuals: SupportingVisual[]; audioPath?: string;
  subtitlePath?: string; sourceTranscript?: Transcript; signal: AbortSignal;
}) {
  const directory = path.join(paths.plans, job.id);
  await mkdir(directory, { recursive: true });
  const media: EditPlanMedia[] = [];
  const files: Record<string, string> = {};
  const byPath = new Map<string, string>();
  const snapshot = async (filePath: string, entry: Omit<EditPlanMedia, "id">) => {
    const previous = byPath.get(filePath);
    if (previous) return previous;
    signal.throwIfAborted();
    const id = randomUUID();
    const extension = path.extname(filePath).match(/^\.[a-zA-Z0-9]{1,8}$/u)?.[0] || ".mp4";
    const filename = `${id}${extension}`;
    await retainFile(filePath, path.join(directory, filename));
    signal.throwIfAborted();
    files[id] = filename;
    media.push({ ...entry, id });
    byPath.set(filePath, id);
    return id;
  };
  try {
    // Keep the bounded stock shortlist available for replacement in the editor.
    for (const asset of job.brollCandidates || [])
      await snapshot(asset.filePath, { name: asset.name, kind: "broll", duration: asset.duration,
        assetId: asset.id, attribution: asset.attribution, selection: asset.selection, stock: asset.stock });
    const plannedVisuals: EditPlan["visuals"] = [];
    for (const visual of visuals) {
      const detail = job.supportingVisuals?.find(item => item.start === visual.start && item.name === visual.label);
      // Uploaded library assets can be replaced by others already in the plan.
      // Their snapshot remains usable if the library item is later removed.
      const { probeMedia } = await import("./engine.js");
      const metadata = await probeMedia(visual.path);
      const mediaId = await snapshot(visual.path, { name: visual.label, kind: visual.kind,
        duration: metadata.duration, assetId: detail?.assetId, attribution: detail?.attribution,
        selection: detail?.selection, stock: detail?.stock });
      plannedVisuals.push({ id: randomUUID(), mediaId, start: visual.start, end: visual.end,
        sourceStart: visual.sourceStart ?? 0, enabled: true, locked: true, reason: detail?.reason, focalPoint: visual.focalPoint });
    }
    const audioMediaId = audioPath ? await snapshot(audioPath,
      { name: "Saved narration", kind: "audio", duration: job.summary!.outputDuration }) : undefined;
    const captions = subtitlePath ? parseCaptionCues(await readFile(subtitlePath, "utf8")) : [];
    signal.throwIfAborted();
    job.editPlan = { version: 1, resolutionSizing: "exact", revision: 1, sourceId: source.id,
      sourceDuration: source.duration, outputDuration: job.summary!.outputDuration,
      createdAt: new Date().toISOString(), settings: structuredClone(job.settings),
      cuts: structuredClone(job.settings.segments || [{ start: job.settings.trimStart, end: job.settings.trimEnd ?? source.duration }]),
      captions, visuals: plannedVisuals, media, narration: job.summary!.narration, audioMediaId };
    job.planFiles = files;
    job.sourceTranscript = sourceTranscript;
    delete job.brollCandidates;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    delete job.brollCandidates;
    throw error;
  }
}

export async function clonePlanFiles(parent: StoredJob, job: StoredJob) {
  const directory = path.join(paths.plans, job.id);
  await mkdir(directory, { recursive: true });
  try {
    job.planFiles = {};
    for (const item of job.editPlan!.media) {
      const source = planMediaPath(parent, item.id);
      const filename = parent.planFiles![item.id]!;
      await retainFile(source, path.join(directory, filename));
      job.planFiles[item.id] = filename;
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function renderInputsFromPlan(job: StoredJob, workDir: string) {
  const plan = job.editPlan!;
  job.settings = structuredClone(plan.settings);
  const supportingVisuals: SupportingVisual[] = plan.visuals.filter(item => item.enabled).map(item => {
    const media = plan.media.find(media => media.id === item.mediaId)!;
    return { path: planMediaPath(job, item.mediaId), start: item.start, end: item.end,
      sourceStart: item.sourceStart, kind: media.kind as "broll" | "graphic", label: media.name, focalPoint: item.focalPoint };
  });
  job.supportingVisuals = plan.visuals.filter(item => item.enabled).map(item => {
    const media = plan.media.find(media => media.id === item.mediaId)!;
    return { name: media.name, kind: media.kind as "broll" | "graphic", start: item.start, end: item.end,
      sourceStart: item.sourceStart, assetId: media.assetId, attribution: media.attribution,
      selection: media.selection, stock: media.stock, reason: item.reason };
  });
  if (job.summary) {
    const changes = job.summary.changes.filter(change => !/B-roll cutaway|animated card|captions|hook|Key-point overlays/iu.test(change));
    const broll = job.supportingVisuals.filter(item => item.kind === "broll").length;
    const cards = job.supportingVisuals.filter(item => item.kind === "graphic").length;
    if (plan.settings.hookText) changes.push("Edited opening hook");
    if (plan.captions.length) changes.push("Saved captions");
    if (broll) changes.push(`${broll} B-roll cutaway${broll === 1 ? "" : "s"}`);
    if (cards) changes.push(`${cards} animated card${cards === 1 ? "" : "s"}`);
    if (job.settings.callouts?.length) changes.push("Key-point overlays");
    job.summary = { ...job.summary, changes, outputDuration: plan.outputDuration };
  }
  let subtitlePath: string | undefined;
  if (plan.captions.length) {
    subtitlePath = path.join(workDir, "plan-captions.srt");
    await writeFile(subtitlePath, captionCuesSrt(plan.captions), "utf8");
  }
  return { supportingVisuals, subtitlePath,
    audioPath: plan.audioMediaId ? planMediaPath(job, plan.audioMediaId) : undefined };
}
