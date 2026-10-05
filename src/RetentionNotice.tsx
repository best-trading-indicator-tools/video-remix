import type { RenderJob } from '../shared/types';

export function expiryText(date: string) {
  const remaining = Date.parse(date) - Date.now();
  const when = new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return remaining <= 0 ? `Eligible for cleanup now · ${when}` : `Expires ${when} · ${remaining < 3_600_000 ? 'less than 1 hour' : `${Math.ceil(remaining / 3_600_000)} hours`} left`;
}
export default function RetentionNotice({ job }: { job: RenderJob }) {
  return <p className={`file-retention ${job.keptAt || job.draftSavedAt ? 'is-protected' : ''}`}>
    {job.keptAt ? 'Kept · export and editing files protected' : job.draftSavedAt ? 'Saved draft · export and editing files protected' : job.expiresAt ? expiryText(job.expiresAt) : 'Files protected while processing'}
  </p>;
}
