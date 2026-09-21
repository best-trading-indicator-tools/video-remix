import { z } from "zod";
import type { ExportHistoryEntry, EditSegment } from "../shared/types.js";
import type { DraftHistoryMatch } from "../shared/draft-history.js";

export const draftHistorySchema = z.object({ drafts: z.array(z.object({
  id: z.string().min(1).max(120), sourceId: z.string().uuid(),
  cuts: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().max(86400) }).strict()
    .refine(cut => cut.end > cut.start)).min(1).max(60),
}).strict()).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length) }).strict();
function merged(cuts: EditSegment[]): EditSegment[] {
  const result: EditSegment[] = [];
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
    else result.push({ start: cut.start, end: cut.end });
  }
  return result;
}
/** Exact-source intervals only. A similar picture does not establish matching timestamps. */
export function draftHistoryMatches(cuts: EditSegment[], entries: ExportHistoryEntry[]) {
  const requested = merged(cuts), duration = requested.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  const matches: DraftHistoryMatch[] = [];
  for (const entry of entries) {
    const used = merged(entry.cuts);
    const overlapSeconds = requested.reduce((sum, cut) => sum + used.reduce((total, prior) =>
      total + Math.max(0, Math.min(cut.end, prior.end) - Math.max(cut.start, prior.start)), 0), 0);
    if (overlapSeconds < 0.05) continue;
    matches.push({ id: entry.id, title: entry.title || entry.sourceName, overlapSeconds, draftCoverage: overlapSeconds / duration,
      createdAt: entry.createdAt, publications: entry.publications.map(({ platform, publishedAt, account, url }) => ({ platform, publishedAt, account, url })) });
  }
  matches.sort((a, b) => Number(!!b.publications.length) - Number(!!a.publications.length) || b.draftCoverage - a.draftCoverage || b.createdAt.localeCompare(a.createdAt));
  return { matches: matches.slice(0, 5), total: matches.length };
}
