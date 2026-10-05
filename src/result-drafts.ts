import type { EditPlan, EditPlanChanges } from '../shared/types';
import { apiRequest } from './api-client';

export interface ResultDraft {
  draft: EditPlan; refreshBroll: boolean; brollCount: number; brollMaxCoverage: number;
  promptAnchor: { plan: EditPlan; changes: EditPlanChanges } | null;
  reviewTime: number;
}
export interface SavedDraft { revision: number; content: string; savedAt: string; token: string }
export interface DraftBackup { revision: number; content: string | null; savedAt: string; token: string | null }
export const draftKey = (id: string) => `remix-result-draft-v1:${id}`;
export function parseDraft(content: string, plan: EditPlan): ResultDraft | null {
  try {
    const value = JSON.parse(content) as ResultDraft;
    if (!value?.draft || value.draft.sourceId !== plan.sourceId || value.draft.revision !== plan.revision ||
      !Array.isArray(value.draft.cuts) || !value.draft.cuts.length || !Array.isArray(value.draft.captions) ||
      !Array.isArray(value.draft.visuals) || !value.draft.settings || !Array.isArray(value.draft.media) ||
      typeof value.refreshBroll !== 'boolean' || !Number.isFinite(value.brollCount) || !Number.isFinite(value.brollMaxCoverage)) return null;
    return { ...value, reviewTime: Number.isFinite(value.reviewTime) ? Math.max(0, value.reviewTime) : 0 };
  } catch { return null; }
}

/** Serial writes prevent a slow save from overwriting a newer gesture or a reset. */
export class DraftWriter {
  private pending: string | null;
  private written: string | null;
  private token: string | null;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  localSafe = true;
  constructor(private id: string, private revision: number, saved: SavedDraft | null,
    private status: (message: string, failed: boolean) => void,
    private storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
    private request = apiRequest) {
    this.pending = this.written = saved?.content ?? null; this.token = saved?.token ?? null;
  }
  schedule(content: string | null) {
    this.pending = content;
    try {
      if (content === this.written && !this.running) this.storage.removeItem(draftKey(this.id));
      else this.storage.setItem(draftKey(this.id), JSON.stringify({ revision: this.revision, content, savedAt: new Date().toISOString(), token: this.token }));
      this.localSafe = true;
    } catch { this.localSafe = false; }
    if (content === this.written && !this.running) { this.localSafe = true; return; }
    this.status(this.localSafe ? 'Saved in this browser · syncing…' : 'Saving draft…', false);
    clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), 400);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.pending !== this.written) {
        const content = this.pending;
        try {
          if (content === null) {
            await this.request(`/api/jobs/${this.id}/draft`, { method: 'DELETE', headers: this.token ? { 'If-Match': this.token } : {} });
            this.token = null;
          } else {
            const result = await this.request<{ draft: SavedDraft }>(`/api/jobs/${this.id}/draft`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ revision: this.revision, content, token: this.token }) });
            this.token = result.draft.token;
          }
          this.written = content;
          if (this.pending === content) {
            try { this.storage.removeItem(draftKey(this.id)); } catch { /* Durable server copy is saved. */ }
            this.localSafe = true;
            this.status(content === null ? 'No unsaved changes' : 'Draft saved · editing files protected', false);
          }
        } catch (error) {
          this.status(`${this.localSafe ? 'Browser backup saved. ' : 'Draft not saved. Keep this window open. '}${(error as Error).message}`, true);
          break;
        }
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
}
