import type { ExportReview, RenderJob } from './types.js';

export const REVIEW_LABELS = { all: 'All decisions', unreviewed: 'Unreviewed', accepted: 'Accepted', 'needs-edit': 'Needs edits', rejected: 'Rejected' } as const;
export type ReviewFilter = keyof typeof REVIEW_LABELS;
export function reviewStatus(review?: ExportReview): Exclude<ReviewFilter, 'all'> {
  return review?.verdict?.startsWith('accepted-') ? 'accepted' : review?.verdict === 'needs-edit' ? 'needs-edit' : review?.verdict === 'rejected' ? 'rejected' : 'unreviewed';
}
export interface LibraryFilters { search: string; review: ReviewFilter; publication: string; aspect: string; project: string; after: string; before: string }
export const EMPTY_FILTERS: LibraryFilters = { search: '', review: 'all', publication: 'all', aspect: '', project: '', after: '', before: '' };
export function matchesExport(job: RenderJob, filters: LibraryFilters) {
  const date = (job.finishedAt || job.createdAt).slice(0, 10);
  return (!filters.search || [job.exportName, job.summary?.title, job.sourceName, job.project].join(' ').toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase()))
    && (filters.review === 'all' || job.status === 'completed' && reviewStatus(job.review) === filters.review)
    && (filters.publication === 'all' || (job.publicationStatus || 'unpublished') === filters.publication)
    && (!filters.aspect || job.settings.aspect === filters.aspect)
    && (!filters.project || job.project === filters.project)
    && (!filters.after || date >= filters.after) && (!filters.before || date <= filters.before);
}
/** Flatten each revision family together, even when an intermediate export expired. */
export function revisionFamilies<T extends { id: string; parentJobId?: string }>(items: T[]): T[][] {
  const byId = new Map(items.map(item => [item.id, item]));
  const root = (item: T) => {
    const seen = new Set([item.id]); let id = item.id;
    while (item.parentJobId && !seen.has(item.parentJobId)) {
      id = item.parentJobId; seen.add(id);
      const parent = byId.get(id); if (!parent) break; item = parent;
    }
    return id;
  };
  const groups = new Map<string, T[]>();
  for (const item of items) { const id = root(item); groups.set(id, [...(groups.get(id) || []), item]); }
  return [...groups.values()];
}
