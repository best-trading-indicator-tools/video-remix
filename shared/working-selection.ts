export type WorkingScope = 'current' | 'selected' | 'all';

/** The same source list drives editing, prompt proposals and both export modes. */
export function workingVideos<T extends { id: string }>(sources: T[], previewedId: string | undefined, scope: WorkingScope, checkedIds: string[]): T[] {
  if (scope === 'all') return sources;
  if (scope === 'current') return sources.filter(source => source.id === previewedId);
  const checked = new Set(checkedIds);
  return sources.filter(source => checked.has(source.id));
}

/** A checkbox starts from the visible working set, including This video / All videos. */
export function toggleWorkingVideo(targets: { id: string }[], id: string, checked: boolean): string[] {
  const ids = new Set(targets.map(source => source.id));
  if (checked) ids.add(id);
  else ids.delete(id);
  return [...ids];
}
