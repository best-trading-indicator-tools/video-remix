import { access, link, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ownFootageSchema, resolveFootagePlacement, type OwnFootagePlacement } from "../shared/own-footage.js";
import { paths } from "./config.js";
import { state, type StoredJob } from "./store.js";
import type { ResolvedFootage } from "./footage-composition.js";

export function footageFile(job: StoredJob, assetId: string): string {
  const asset = job.footageFiles?.[assetId];
  if (!asset || asset.filename !== path.basename(asset.filename)) throw new Error("Saved footage is unavailable.");
  return path.join(paths.plans, job.id, asset.filename);
}

export function validateFootage(placements: OwnFootagePlacement[] = [], job?: StoredJob) {
  ownFootageSchema.parse(placements);
  return placements.map(item => {
    const media = job?.footageFiles?.[item.assetId] ?? state.broll.find(asset => asset.id === item.assetId);
    if (!media) throw new Error("One of your uploaded clips is no longer available. Upload it again or remove its placement.");
    const resolved = resolveFootagePlacement(item, media.duration);
    if (resolved.end - resolved.start < 0.1) throw new Error("Select at least 0.1 seconds of your footage");
    if (resolved.end > media.duration + 0.001) throw new Error("Your selected footage ends beyond the uploaded clip.");
    return resolved;
  });
}

export function previewFootage(placements: OwnFootagePlacement[] = []): ResolvedFootage[] {
  return validateFootage(placements).map(placement => {
    const asset = state.broll.find(asset => asset.id === placement.assetId)!;
    return { placement, name: asset.name, path: asset.filePath, duration: asset.duration, hasAudio: asset.hasAudio };
  });
}

export async function retainFootage(job: StoredJob, signal: AbortSignal): Promise<ResolvedFootage[]> {
  let placements = job.settings.ownFootage ?? [];
  for (const item of placements) if (job.footageFiles?.[item.assetId]) {
    try { await access(footageFile(job, item.assetId)); }
    catch { delete job.footageFiles[item.assetId]; }
  }
  placements = validateFootage(placements, job);
  if (!placements.length) return [];
  job.settings.ownFootage = placements;
  if (job.editPlan) job.editPlan.settings.ownFootage = structuredClone(placements);
  await mkdir(path.join(paths.plans, job.id), { recursive: true });
  job.footageFiles ??= {};
  for (const placement of placements) {
    signal.throwIfAborted();
    if (job.footageFiles[placement.assetId]) continue;
    const asset = state.broll.find(asset => asset.id === placement.assetId)!;
    const filename = `footage-${asset.id}${path.extname(asset.filePath).match(/^\.[a-zA-Z0-9]{1,8}$/u)?.[0] || ".mp4"}`;
    const destination = path.join(paths.plans, job.id, filename);
    try { await link(asset.filePath, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") await copyFile(asset.filePath, destination); }
    job.footageFiles[asset.id] = { filename, name: asset.name, duration: asset.duration, hasAudio: asset.hasAudio };
  }
  signal.throwIfAborted();
  return placements.map(placement => ({ placement, ...job.footageFiles![placement.assetId]!, path: footageFile(job, placement.assetId) }));
}

export async function cloneFootage(parent: StoredJob, job: StoredJob) {
  if (!parent.footageFiles) return;
  job.footageFiles = structuredClone(parent.footageFiles);
  for (const assetId of Object.keys(job.footageFiles)) {
    const target = footageFile(job, assetId);
    try { await link(footageFile(parent, assetId), target); }
    catch { await copyFile(footageFile(parent, assetId), target); }
  }
}
