import { z } from 'zod';
import { revisionFamilies } from './library.js';
import type { RenderJob } from './types.js';

export const MAX_EXPORT_SELECTION = 300;
export const exportIdsSchema = z.array(z.string().min(1).max(120)).min(1).max(MAX_EXPORT_SELECTION)
  .refine(ids => new Set(ids).size === ids.length, 'Choose each export only once.');

export function exportRevisionFamilies(batch: RenderJob[]) {
  return revisionFamilies(batch).map(family => family.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}

/** Selection follows the cards actually shown, including the revision disclosure state. */
export function selectableExports(batches: RenderJob[][], expanded: string[]) {
  const open = new Set(expanded);
  return batches.flatMap(batch => exportRevisionFamilies(batch)
    .flatMap(family => open.has(family[0].id) ? family : [family[0]]))
    .filter(job => job.status !== 'queued' && job.status !== 'processing');
}

export function retainExportSelection(ids: string[], available: Pick<RenderJob, 'id'>[]) {
  const allowed = new Set(available.map(job => job.id));
  return [...new Set(ids)].filter(id => allowed.has(id)).slice(0, MAX_EXPORT_SELECTION);
}
