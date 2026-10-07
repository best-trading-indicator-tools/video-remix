import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { autoOptionsObject, autoOptionsSchema, settingsSchema } from '../schema.js';
import { blackBandsPatchSchema, applyBlackBandsPatch } from '../../shared/black-bands.js';
import { captionStyleSchema } from '../../shared/caption-style.js';
import { pacingOptionsSchema } from '../../shared/pacing.js';
import type { AutoOptions, RemixSettings } from '../../shared/types.js';

const sharedPatch = { blackBands: blackBandsPatchSchema.optional(), captionStyle: captionStyleSchema.partial().strict().optional() };
export const autoPatchSchema = autoOptionsObject.omit({ ownFootageSourceId: true }).partial().extend({
  ...sharedPatch, aspect: autoOptionsObject.shape.aspect.removeDefault().optional(),
  targetDuration: autoOptionsObject.shape.targetDuration.removeDefault().optional(),
  narration: autoOptionsObject.shape.narration.removeDefault().optional(),
  pacing: z.object(pacingOptionsSchema.shape).partial().strict().optional(),
}).strict();
export const manualPatchSchema = settingsSchema.omit({ ownFootageSourceId: true }).partial().extend(sharedPatch).strict();
export type DraftItem = { sourceId: string; name: string; options?: AutoOptions; settings?: RemixSettings; variants: number };
export interface EditDraft {
  id: string; revision: number; title: string; mode: 'auto' | 'manual';
  status: 'ready' | 'submitting' | 'submitted'; items: DraftItem[];
  createdAt: string; updatedAt: string; receipt?: { batchId: string; jobIds: string[] };
}

/** Start with an original-voice full video; paid/generated features are opt-in. */
export const MCP_AUTO_DEFAULTS: AutoOptions = {
  aspect: 'original', targetDuration: 45, durationMode: 'full', narration: false,
  captions: 'keep', audio: 'original', visualSources: [], editorialMode: 'off', finishedReview: false,
  pacing: { mode: 'off', minimumPause: .9, keepPause: .35, removeFillers: false }, versionMode: 'moments',
};

export function patchItem(item: DraftItem, mode: EditDraft['mode'], value: unknown, variants?: number): DraftItem {
  const patch = (mode === 'auto' ? autoPatchSchema : manualPatchSchema).parse(value);
  const current = mode === 'auto' ? item.options! : item.settings!;
  const next = { ...current, ...patch,
    ...(patch.blackBands ? { blackBands: applyBlackBandsPatch(current.blackBands, patch.blackBands) } : {}),
    ...(patch.captionStyle ? { captionStyle: { fontSize: 20, bottomPercent: 100 / 12, ...current.captionStyle, ...patch.captionStyle } } : {}),
    ...(patch.ownFootage ? { ownFootageSourceId: item.sourceId } : {}),
  };
  if (next.ownFootage !== undefined) next.ownFootageSourceId = item.sourceId;
  if (mode === 'manual') return { ...item, variants: 1, settings: settingsSchema.parse(next) };
  const automatic = autoPatchSchema.parse(patch);
  const options = autoOptionsSchema.parse({ ...next, ...(automatic.pacing ? { pacing: { ...MCP_AUTO_DEFAULTS.pacing, ...item.options?.pacing, ...automatic.pacing } } : {}) });
  let count = variants ?? item.variants;
  if (options.durationMode === 'full') {
    if (variants && variants !== 1 || automatic.narration || automatic.versionMode === 'angles')
      throw new Error('Full video keeps one version and the original voice. Choose excerpt mode for multiple versions, angles or narration.');
    count = 1; options.narration = false; options.versionMode = 'moments';
  }
  if (options.versionMode === 'angles' && count > 4) throw new Error('New angles supports up to four versions.');
  if (options.narration && (options.captions === 'keep' || ['off', 'original'].includes(options.audio ?? '') || options.versionMode === 'angles'))
    throw new Error('Narration needs captions, sound treatment and moments mode. Include these settings explicitly.');
  return { ...item, variants: count, options };
}

/** Separate from the app database; SQLite makes drafts shared across MCP clients. */
export class DraftStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)');
    chmodSync(filename, 0o600);
  }
  close() { this.db.close(); }
  get(id: string): EditDraft {
    const row = this.db.prepare('SELECT data FROM drafts WHERE id=?').get(id);
    if (!row) throw new Error('MCP draft not found. Use list_drafts or create_draft.');
    return JSON.parse(row.data as string);
  }
  list(limit = 30) {
    return this.db.prepare('SELECT data FROM drafts ORDER BY rowid DESC LIMIT ?').all(limit).map(row => {
      const { id, revision, title, mode, status, createdAt, updatedAt, items, receipt } = JSON.parse(row.data as string) as EditDraft;
      return { id, revision, title, mode, status, createdAt, updatedAt, videos: items.map(({ sourceId, name }) => ({ sourceId, name })), receipt };
    });
  }
  create(value: Pick<EditDraft, 'title' | 'mode' | 'items'>): EditDraft {
    const now = new Date().toISOString();
    const draft: EditDraft = { ...value, id: randomUUID(), revision: 1, status: 'ready', createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO drafts VALUES (?,?,?,?)').run(draft.id, draft.revision, draft.status, JSON.stringify(draft));
    return draft;
  }
  ready(id: string, revision: number) {
    const draft = this.get(id);
    if (draft.revision !== revision) throw new Error('This draft changed in another request. Use get_draft and its current revision.');
    if (draft.status !== 'ready') throw new Error('This draft was already submitted. Create a new draft for another export.');
    return draft;
  }
  replace(current: EditDraft, next: EditDraft): EditDraft {
    const value = { ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    const saved = this.db.prepare('UPDATE drafts SET revision=?,status=?,data=? WHERE id=? AND revision=? AND status=?')
      .run(value.revision, value.status, JSON.stringify(value), current.id, current.revision, current.status);
    if (!saved.changes) throw new Error('This draft changed in another request. Use get_draft before trying again.');
    return value;
  }
}
