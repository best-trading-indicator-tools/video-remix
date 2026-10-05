import type { RenderJob } from './types.js';

export function exportTitle(job: Pick<RenderJob, 'exportName' | 'summary' | 'settings' | 'sourceName' | 'variant'>): string {
  const explicit = job.exportName?.trim() || job.settings.hookText?.trim();
  if (explicit) return explicit.slice(0, 90);
  const title = job.summary?.title?.trim();
  if (title && title !== job.sourceName && !/^hf_\d|[a-f\d]{8}-[a-f\d]{4}-/iu.test(title)) return title.slice(0, 90);
  const name = job.sourceName.replace(/\.[a-z\d]{2,5}$/iu, '').replace(/[_-]+/gu, ' ').trim();
  return /^(hf\s*\d|[a-f\d]{20})/iu.test(name) ? `Video · cut ${job.variant}` : `${name.slice(0, 55) || 'Video'} · cut ${job.variant}`;
}
export function exportStatus(job: Pick<RenderJob, 'status' | 'qualityReport' | 'finishedReviewReport' | 'editorialReport'>) {
  if (job.status === 'failed') return { kind: 'problem', label: 'Problem' } as const;
  if (job.status !== 'completed') return { kind: 'pending', label: job.status[0]!.toUpperCase() + job.status.slice(1) } as const;
  const reports = [job.qualityReport, job.finishedReviewReport, job.editorialReport].filter(Boolean);
  return reports.length && reports.every(report => report!.status === 'pass')
    ? { kind: 'ready', label: 'Ready' } as const : { kind: 'review', label: 'Review needed' } as const;
}
export const visibleExportChanges = (changes: string[]) => changes.filter(change => !/^0\s+(?:uploaded|B-roll|supporting|animated|cover)\b/iu.test(change));
