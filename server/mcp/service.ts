import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS, type BrollAsset, type RenderJob, type VideoSource, type AutoOptions, type RemixSettings } from '../../shared/types.js';
import { autoBatchSchema, batchSchema } from '../schema.js';
import { ownFootageSchema } from '../../shared/own-footage.js';
import { blackBandChangeSummary } from '../../shared/black-bands.js';
import { captionStyleDescription } from '../../shared/caption-style.js';
import { DraftStore, MCP_AUTO_DEFAULTS, patchItem, type DraftItem, type EditDraft } from './drafts.js';
import { LocalApiError, RemixApi } from './api.js';

export class RemixMcpService {
  constructor(readonly api: RemixApi, readonly drafts: DraftStore) {}
  async videos(signal?: AbortSignal) { return (await this.api.request<{ sources: VideoSource[] }>('/api/sources', undefined, signal)).sources; }
  async footage(signal?: AbortSignal) { return (await this.api.request<{ assets: BrollAsset[] }>('/api/broll', undefined, signal)).assets; }
  async exports(signal?: AbortSignal) { return (await this.api.request<{ jobs: RenderJob[] }>('/api/jobs', undefined, signal)).jobs; }
  async sourcesFor(ids: string[], signal?: AbortSignal) {
    const videos = await this.videos(signal);
    return ids.map(id => {
      const video = videos.find(item => item.id === id);
      if (!video) throw new Error(`Source ${id} is unavailable. Use list_videos to choose current source IDs.`);
      return video;
    });
  }
  review(draft: EditDraft) {
    const summary = draft.items.map(item => {
      const settings = item.options ?? item.settings!;
      return { sourceId: item.sourceId, name: item.name, exports: item.variants,
        description: [draft.mode === 'auto' ? `${item.options?.durationMode === 'full' ? 'Full video' : 'Auto excerpt'} · ${settings.aspect}` : `Manual edit · ${settings.aspect}`,
          ...(settings.blackBands ? blackBandChangeSummary(undefined, settings.blackBands) : []),
          ...(settings.captionStyle ? [captionStyleDescription(settings.captionStyle)] : []),
          ...(settings.ownFootage ?? []).map(clip => `${clip.appendToEnd ? 'Append whole ending clip' : `${clip.mode} at ${clip.at}s`}: ${clip.assetId} · ${clip.audio} audio`)],
      };
    });
    return { draft, summary, totalExports: draft.items.reduce((sum, item) => sum + item.variants, 0),
      note: 'MCP drafts are shared between local MCP clients and are separate from unsaved browser settings. Only render_draft creates exports; results appear in the app’s Exports tab.' };
  }
  async create(input: { sourceIds: string[]; mode: 'auto' | 'manual'; title?: string; auto?: unknown; manual?: unknown; variants?: number }, signal?: AbortSignal) {
    if (input.mode === 'auto' && input.manual || input.mode === 'manual' && (input.auto || input.variants && input.variants !== 1))
      throw new Error('Choose one mode and supply its settings only. Manual drafts make one export per source.');
    const sources = await this.sourcesFor(input.sourceIds, signal);
    const items = sources.map(source => patchItem({ sourceId: source.id, name: source.name, variants: 1,
      ...(input.mode === 'auto' ? { options: structuredClone(MCP_AUTO_DEFAULTS) } : { settings: { ...DEFAULT_SETTINGS } }) },
      input.mode, input.auto ?? input.manual ?? {}, input.variants));
    await this.validate(items, input.mode, signal);
    signal?.throwIfAborted();
    return this.review(this.drafts.create({ title: input.title ?? 'MCP video edits', mode: input.mode, items }));
  }
  targets(draft: EditDraft, ids?: string[]) {
    if (ids?.some(id => !draft.items.some(item => item.sourceId === id))) throw new Error('Every selected source must belong to this draft.');
    return new Set(ids ?? draft.items.map(item => item.sourceId));
  }
  async validate(items: DraftItem[], mode: EditDraft['mode'], signal?: AbortSignal) {
    const sources = await this.sourcesFor(items.map(item => item.sourceId), signal);
    const needsFootage = items.some(item => (item.options ?? item.settings)?.ownFootage?.length);
    const assets = needsFootage ? await this.footage(signal) : [];
    for (const [index, item] of items.entries()) {
      const settings = item.options ?? item.settings!;
      for (const placement of settings.ownFootage ?? []) {
        const asset = assets.find(asset => asset.id === placement.assetId);
        if (!asset || (!placement.appendToEnd && placement.end > asset.duration + .001)) throw new Error(`${item.name}: choose available footage and a valid interval within it.`);
      }
      if (mode === 'manual') {
        const manual = item.settings!, duration = sources[index]!.duration;
        if ((manual.trimEnd ?? duration) > duration + .05 || manual.trimStart >= (manual.trimEnd ?? duration) - .05 || manual.segments?.some(cut => cut.end > duration + .001))
          throw new Error(`${item.name}: keep trim and cut times inside the source duration.`);
      }
    }
    if (mode === 'auto') autoBatchSchema.parse({ items: items.map(({ sourceId, options, variants }) => ({ sourceId, options, variants })) });
    else batchSchema.parse({ items: items.map(({ sourceId, settings }) => ({ sourceId, settings })), variants: 1 });
  }
  async update(input: { draftId: string; revision: number; sourceIds?: string[]; auto?: unknown; manual?: unknown; variants?: number }, signal?: AbortSignal) {
    const draft = this.drafts.ready(input.draftId, input.revision), targets = this.targets(draft, input.sourceIds);
    if (draft.mode === 'auto' && input.manual || draft.mode === 'manual' && (input.auto || input.variants && input.variants !== 1))
      throw new Error('Supply settings for the draft’s current mode only.');
    const items = draft.items.map(item => targets.has(item.sourceId) ? patchItem(item, draft.mode, input.auto ?? input.manual ?? {}, input.variants) : item);
    await this.validate(items, draft.mode, signal);
    signal?.throwIfAborted();
    return this.review(this.drafts.replace(draft, { ...draft, items }));
  }
  async append(input: { draftId: string; revision: number; assetId: string; sourceIds?: string[]; audio: 'clip' | 'mute'; fit: 'contain' | 'crop' }, signal?: AbortSignal) {
    const draft = this.drafts.ready(input.draftId, input.revision), targets = this.targets(draft, input.sourceIds);
    const asset = (await this.footage(signal)).find(asset => asset.id === input.assetId);
    if (!asset) throw new Error('Ending clip not found. Use list_footage or import_footage first.');
    const items = draft.items.map(item => {
      if (!targets.has(item.sourceId)) return item;
      const current = item.options ?? item.settings!;
      return patchItem(item, draft.mode, { ownFootage: ownFootageSchema.parse([...(current.ownFootage ?? []), {
        id: randomUUID(), assetId: asset.id, mode: 'insert', appendToEnd: true, at: 0, start: 0, end: asset.duration, audio: input.audio, fit: input.fit,
      }]) });
    });
    await this.validate(items, draft.mode, signal);
    signal?.throwIfAborted();
    return this.review(this.drafts.replace(draft, { ...draft, items }));
  }
  async prompt(input: { draftId: string; revision: number; prompt: string; sourceIds?: string[] }, signal?: AbortSignal) {
    const draft = this.drafts.ready(input.draftId, input.revision), targets = this.targets(draft, input.sourceIds);
    const items: DraftItem[] = new Array(draft.items.length), summaries: { sourceId: string; summary: string[] }[] = [];
    const modes = new Set<EditDraft['mode']>();
    const controller = new AbortController();
    const combined = AbortSignal.any([...(signal ? [signal] : []), controller.signal, AbortSignal.timeout(150_000)]);
    let cursor = 0;
    const clarifications: string[] = [];
    // Match the app's two-request limit; publish the draft only after the entire batch succeeds.
    try {
      await Promise.all(Array.from({ length: Math.min(2, draft.items.length) }, async () => {
        while (cursor < draft.items.length) {
          combined.throwIfAborted();
          const index = cursor++, item = draft.items[index]!;
          if (!targets.has(item.sourceId)) { items[index] = item; modes.add(draft.mode); continue; }
          const result = await this.api.request<{ options?: AutoOptions; settings?: RemixSettings; variants?: number; manual?: RemixSettings; auto?: { options: AutoOptions; variants: number }; clarification?: string; unchanged?: boolean; summary: string[] }>(
            `/api/sources/${item.sourceId}/${draft.mode === 'auto' ? 'auto-prompt' : 'edit-prompt'}`,
            { prompt: input.prompt, ...(draft.mode === 'auto' ? { options: item.options, variants: item.variants } : { settings: item.settings }) }, combined, 120_000);
          if (result.clarification && !result.unchanged) { clarifications.push(`${item.name}: ${result.clarification}`); continue; }
          const mode = result.manual ? 'manual' : result.auto ? 'auto' : draft.mode;
          modes.add(mode);
          const next: DraftItem = { sourceId: item.sourceId, name: item.name, variants: mode === 'manual' ? 1 : result.auto?.variants ?? result.variants ?? item.variants,
            ...(mode === 'auto' ? { options: result.auto?.options ?? result.options ?? item.options } : { settings: result.manual ?? result.settings ?? item.settings }) };
          items[index] = patchItem(next, mode, {}); summaries.push({ sourceId: item.sourceId, summary: result.summary });
        }
      }));
    } finally { controller.abort(); }
    if (clarifications.length) return { ...this.review(draft), clarification: clarifications.join('\n'), applied: false };
    if (modes.size !== 1) return { ...this.review(draft), clarification: 'This request needs different editing modes. Create separate drafts or use changes supported by one mode for every video.', applied: false };
    const mode = [...modes][0]!;
    await this.validate(items, mode, signal);
    signal?.throwIfAborted();
    return { ...this.review(this.drafts.replace(draft, { ...draft, items, mode })), promptSummary: summaries, applied: true };
  }
  async render(id: string, revision: number, signal?: AbortSignal) {
    const existing = this.drafts.get(id);
    if (existing.status === 'submitted') return { draftId: id, ...existing.receipt, alreadySubmitted: true };
    if (existing.status === 'submitting') throw new Error('This draft already has a render submission in progress or interrupted. Check list_exports before creating another batch; it will not be submitted twice.');
    const draft = this.drafts.ready(id, revision);
    await this.validate(draft.items, draft.mode, signal);
    signal?.throwIfAborted();
    const claimed = this.drafts.replace(draft, { ...draft, status: 'submitting' });
    const body = draft.mode === 'auto'
      ? autoBatchSchema.parse({ items: draft.items.map(({ sourceId, options, variants }) => ({ sourceId, options, variants })) })
      : batchSchema.parse({ items: draft.items.map(({ sourceId, settings }) => ({ sourceId, settings })), variants: 1 });
    try {
      const receipt = await this.api.request<{ batchId: string; jobs: RenderJob[] }>(draft.mode === 'auto' ? '/api/auto/jobs' : '/api/jobs', body, signal);
      const value = { batchId: receipt.batchId, jobIds: receipt.jobs.map(job => job.id) };
      this.drafts.replace(claimed, { ...claimed, status: 'submitted', receipt: value });
      return { draftId: id, ...value, jobs: receipt.jobs.map(job => this.jobSummary(job)), note: 'Rendering runs in Remix Studio. Use get_export for progress or open the app’s Exports tab.' };
    } catch (error) {
      // A definitive rejection can be corrected; an uncertain response must not duplicate a charged render.
      if (error instanceof LocalApiError && error.status && error.status >= 400 && error.status < 500)
        this.drafts.replace(claimed, { ...claimed, status: 'ready' });
      throw error;
    }
  }
  jobSummary(job: RenderJob) {
    return { id: job.id, sourceId: job.sourceId, sourceName: job.sourceName, batchId: job.batchId, status: job.status, phase: job.phase,
      progress: job.progress, createdAt: job.createdAt, finishedAt: job.finishedAt, error: job.error, summary: job.summary,
      deepseekUsage: job.deepseekUsage, downloadUrl: job.downloadUrl ? `${this.api.baseUrl}${job.downloadUrl}` : undefined,
      captionUrl: job.captionUrl ? `${this.api.baseUrl}${job.captionUrl}` : undefined };
  }
  async importFootage(filename: string, signal?: AbortSignal) {
    if (!path.isAbsolute(filename)) throw new Error('Use an absolute local video path.');
    const info = await stat(filename);
    const health = await this.api.request<{ maxFileSize: number }>('/api/health', undefined, signal);
    if (!info.isFile() || !/\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg)$/iu.test(filename) || info.size <= 0 || info.size > health.maxFileSize)
      throw new Error('Choose a supported, non-empty video within the app’s upload size limit.');
    const form = new FormData(); form.append('videos', await openAsBlob(filename), path.basename(filename));
    return this.api.fetchJson('/api/broll', { method: 'POST', body: form, signal }, 120_000);
  }
}
