import { autoPicturePreview } from "../../shared/preview-settings.js";
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { RemixMcpService } from './service.js';
import { settingsSchema, focalPointSchema } from '../schema.js';
import { editPlanChangesSchema } from '../edit-plan.js';
import { discoveryRequestSchema } from '../clip-discovery.js';
import { draftHistorySchema } from '../draft-history.js';
import { quickReviewSchema } from '../export-tools.js';
import { measurementsSchema } from '../measurements.js';
import { publicationChangesSchema } from '../history.js';
import { pacingOptionsSchema } from '../../shared/pacing.js';
import { TITLE_DESIGNS } from '../../shared/text-overlays.js';
import { CAPTION_FONTS, CAPTION_PRESETS } from '../../shared/caption-style.js';
import { TEXT_ANIMATIONS } from '../../shared/text-animation.js';
import { platformSchema, promotionProfileSchema, postDraftSchema, crossPostSchema } from '../../shared/publishing.js';
import { appStoreImportSchema } from '../../shared/app-store.js';
import { languageNameSchema } from '../../shared/publishing-language.js';
import { API_PROVIDERS } from '../../shared/api-keys.js';
import { socialCarouselLink, socialMediaLink } from '../../shared/social-imports.js';

const id = z.uuid(), ids = z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length, 'Choose each ID once');
const job = { jobId: id }, empty = z.object({}).strict(), confirm = z.literal(true);
const source = { sourceId: id }, prompt = z.string().trim().min(1).max(2000);
const project = z.string().trim().max(60).regex(/^[^\u0000-\u001f\u007f]*$/u);
const focusCuts = z.array(z.object({ start: z.number().nonnegative().max(86400), end: z.number().positive().max(86400), focalPoint: focalPointSchema.optional() }).strict().refine(cut => cut.end - cut.start >= .04)).min(1).max(60);
const pacingCuts = z.array(z.object({ start: z.number().nonnegative(), end: z.number().positive() }).strict().refine(cut => cut.end - cut.start >= .05)).min(1).max(60);
const analysisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discover'), request: discoveryRequestSchema }).strict(),
  z.object({ kind: z.literal('transcript'), request: z.object(source).strict() }).strict(),
  z.object({ kind: z.literal('pacing'), request: z.object({ ...source, cuts: pacingCuts, options: pacingOptionsSchema }).strict() }).strict(),
  z.object({ kind: z.literal('speaker-focus'), request: z.object({ ...source, cuts: focusCuts, seed: focalPointSchema.optional(), mode: z.enum(['face', 'speaker']).optional() }).strict() }).strict(),
]);

/** Explicit app operations only: no caller-selected HTTP routes, shell commands, or arbitrary files. */
export function registerWorkflowTools(server: McpServer, service: RemixMcpService) {
  function tool<T extends z.ZodObject>(name: string, description: string, schema: T, flags: { readOnly?: boolean; destructive?: boolean; external?: boolean }, run: (input: z.infer<T>, signal: AbortSignal) => Promise<unknown> | unknown) {
    const inputSchema: StandardSchemaWithJSON = schema;
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: !!flags.readOnly, destructiveHint: !!flags.destructive, openWorldHint: !!flags.external, idempotentHint: !!flags.readOnly } }, async (input, context) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run(schema.parse(input), context.mcpReq.signal)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'The operation failed.' }] }; }
    });
  }
  const get = (route: string, signal: AbortSignal) => service.api.request(route, undefined, signal);
  const post = (route: string, body: unknown, signal: AbortSignal, timeout = 120_000) => service.api.request(route, body, signal, timeout);
  const renderPreview = async (input: unknown, signal: AbortSignal) => {
    const result = await post('/api/previews', input, signal);
    return { ...result, ...(typeof result.url === 'string' ? { url: new URL(result.url, service.api.baseUrl).href } : {}) };
  };
  const change = (route: string, method: 'PUT' | 'PATCH' | 'DELETE', body: unknown, signal: AbortSignal) => service.api.mutate(route, method, body, signal);
  const query = (values: Record<string, unknown>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();

  tool('get_editing_catalog', 'Discover title designs, text/caption animations, fonts and caption looks. Use update_draft textEdits for sparse title add/update/remove operations or textOverlays for a complete list. Every Auto/Manual rendering setting is in create_draft/update_draft schemas, including speed 0.5–2, mirror (horizontal flip), preserveEmbeddedText and embeddedTextRegions for readable fixed burned-in captions, watermark masks, focus tracks, audio, metadata, captions and corrections.', empty, { readOnly: true }, () => ({ titleDesigns: TITLE_DESIGNS, animations: TEXT_ANIMATIONS, fonts: CAPTION_FONTS, captionLooks: CAPTION_PRESETS,
    playback: { speed: { min: 0.5, max: 2, default: 1 }, mirror: { default: false, description: "Flip horizontally; added text stays readable" }, preserveEmbeddedText: { default: false, description: "Counter-flip original caption pixels when mirror is true. Fixed text only; area background also changes. Preview to check seams." }, embeddedTextRegions: "[] automatic local English OCR, or up to 4 non-overlapping normalized original-coordinate {x,y,width,height} rectangles. Height <=.35; total area <=.35. Manual areas work for any language. Automatic detection can fail; use manual areas then.", preview: "preview_draft renders the first five seconds for one selected draft source without changing it. Review each source before render_draft. Saved edits can use preview_manual with sourceId and plan.settings from preview_saved_edit (segments=plan.cuts, audioId/subtitleId=null for a picture sample).", bulk: "update_draft auto/manual {speed:1.25,mirror:true}; sourceIds selects a subset, omitted means all draft videos", saved: "preview_saved_edit/render_saved_edit changes.framing {speed:1.25,mirror:true}" },
    textEdits: 'Add {action:"add",text:"Your words",design:"bold",start:0,end:3}; update {action:"update",id:"existing ID",style:{fontSize:30,animation:"pop"}}; remove {action:"remove",id:"existing ID"|"all"}. Update/remove may use index:0 instead of id to target the first text across a batch. Preserve unrequested text and styles. sourceIds targets a draft subset; omit to edit the whole draft.',
    captionCorrections: 'Complete list of {find,replace,wholeWord,caseSensitive}; empty replacement deletes matches. Applies to added captions and exported SRT.',
    browserState: 'MCP drafts and revision history are independent of unsaved browser selections, presets and keyboard shortcuts. Model installation and credential entry remain local Settings/setup tasks.' }));

  tool('import_links', 'Import TikTok, Instagram or YouTube video URLs into the editing library. Poll list_imports for the results.', z.object({ links: z.array(z.string().min(1).max(2048)).min(1).max(100) }).strict(), { external: true }, (input, signal) => post('/api/imports/links', input, signal));
  tool('download_videos', 'Download social video URLs as standalone MP4s, separate from editing sources. Poll list_downloads. Strip metadata by default.', z.object({ links: z.array(z.string().min(1).max(2048)).min(1).max(100), stripMetadata: z.boolean().default(true) }).strict(), { external: true }, (input, signal) => post('/api/downloads', input, signal));
  tool('download_media', 'Download 1-100 URLs as individual videos or images, detecting the content without AI. Supports YouTube videos/Shorts and Instagram/TikTok video or photo posts and short links. Saves one file per post: first item, or Instagram img_index when supplied. Images retain original bytes and format; stripMetadata applies only to videos. For every carousel image use download_carousels instead. Poll list_downloads for download.mediaType and file URLs; get_download_links with explicit downloadIds bundles only selected ready files, or select all ready IDs. Separate from editing sources; expires after 48 hours.', z.object({ links: z.array(z.string().min(1).max(2048).refine(value => { try { socialMediaLink(value); return true; } catch { return false; } }, 'Use an Instagram/TikTok video or image post, or a YouTube video URL')).min(1).max(100), stripMetadata: z.boolean().default(true) }).strict(), { external: true }, (input, signal) => post('/api/downloads', { ...input, kind: 'media' }, signal));
  tool('download_carousels', 'Download 1-100 Instagram post or TikTok photo/carousel URLs as image ZIPs, free without AI. Preserve original image bytes and slide order; skip video slides and audio. Returns queued import IDs and per-link errors. Poll list_downloads for image counts and ZIP URLs. get_download_links with downloadIds creates a bulk ZIP with a folder per selected post. Downloads stay separate from editing sources and expire after 48 hours.', z.object({ links: z.array(z.string().min(1).max(2048).refine(value => { try { socialCarouselLink(value); return true; } catch { return false; } }, 'Use an Instagram post or TikTok photo/carousel URL')).min(1).max(100) }).strict(), { external: true }, (input, signal) => post('/api/downloads', { ...input, kind: 'carousel' }, signal));
  tool('list_downloads', 'List standalone video, image and carousel downloads, progress, errors, downloadKind, download.mediaType for single files, image counts, expiry and ready image/MP4/ZIP URLs.', empty, { readOnly: true }, (_, signal) => get('/api/downloads', signal));
  tool('retry_import', 'Retry a failed local import or social download using its existing import ID.', z.object({ importId: id }).strict(), { external: true }, ({ importId }, signal) => post(`/api/imports/${importId}/retry`, {}, signal));
  tool('cancel_import', 'Cancel/remove an import or standalone download when requested. Requires explicit user intent; does not delete the original local file.', z.object({ importId: id }).strict(), { destructive: true }, ({ importId }, signal) => change(`/api/imports/${importId}`, 'DELETE', undefined, signal));
  tool('list_attachments', 'List available audio and SRT attachment IDs for Manual audioId/subtitleId settings.', empty, { readOnly: true }, (_, signal) => get('/api/attachments', signal));
  tool('import_attachment', 'Import a user-supplied absolute local audio or SRT path. Returns an attachment ID for replacement audio or imported captions.', z.object({ path: z.string().min(1).max(4096), kind: z.enum(['audio', 'subtitle']) }).strict(), {}, async (input, signal) => {
    if (!path.isAbsolute(input.path)) throw new Error('Use an absolute local file path.');
    const info = await stat(input.path);
    const allowed = input.kind === 'subtitle' ? /\.srt$/iu : /\.(mp3|wav|m4a|aac|ogg|flac)$/iu;
    const health = await service.api.request<{ maxFileSize: number }>('/api/health', undefined, signal);
    if (!info.isFile() || info.size <= 0 || info.size > (input.kind === 'subtitle' ? 2 * 1024 * 1024 : Math.min(health.maxFileSize, 100 * 1024 * 1024)) || !allowed.test(input.path)) throw new Error('Choose a supported non-empty audio/SRT file within the upload limit.');
    const form = new FormData(); form.append('kind', input.kind); form.append('file', await openAsBlob(input.path), path.basename(input.path));
    return service.api.fetchJson('/api/attachments', { method: 'POST', body: form, signal }, 120_000);
  });
  tool('tag_footage', 'Set the complete list of descriptive tags on a footage-library clip for matching.', z.object({ assetId: id, tags: z.array(z.string().trim().min(1).max(60)).max(12) }).strict(), {}, ({ assetId, ...body }, signal) => change(`/api/broll/${assetId}`, 'PATCH', body, signal));
  tool('remove_media', 'Remove explicitly requested imported sources or footage-library clips from Remix Studio. Local linked originals remain on disk. Does not operate on arbitrary paths.', z.object({ kind: z.enum(['source', 'footage']), ids, confirm }).strict(), { destructive: true }, async ({ kind, ids }, signal) => {
    const results = [];
    for (const item of ids) { try { results.push({ id: item, result: await change(`/api/${kind === 'source' ? 'sources' : 'broll'}/${item}`, 'DELETE', undefined, signal) }); } catch (error) { results.push({ id: item, error: (error as Error).message }); } }
    return { results };
  });

  const analyses = new Map<string, { id: string; status: 'running' | 'completed' | 'cancelled'; progress?: unknown; results: unknown[]; controller: AbortController }>();
  tool('start_analysis', 'Start transcript preparation, AI short-clip discovery, pause/filler pacing, or face/active-speaker crop analysis for explicit sources. Requests run sequentially for bulk videos. Returns immediately; poll get_analysis. Discovery may incur AI charges. Results propose cuts/focus tracks; use create_draft/update_draft to apply them.', z.object({ requests: z.array(analysisSchema).min(1).max(100) }).strict(), { external: true }, ({ requests }) => {
    if ([...analyses.values()].some(task => task.status === 'running')) throw new Error('Wait for or cancel the current MCP analysis batch.');
    while (analyses.size >= 20) analyses.delete(analyses.keys().next().value!);
    const task = { id: randomUUID(), status: 'running' as const, results: [] as unknown[], controller: new AbortController() };
    analyses.set(task.id, task);
    void (async () => {
      const saved = analyses.get(task.id)!;
      for (const [index, request] of requests.entries()) {
        if (task.controller.signal.aborted) break;
        saved.progress = { index, total: requests.length, sourceId: request.request.sourceId };
        const route = { discover: '/api/shorts/discover', transcript: '/api/shorts/transcript', pacing: '/api/shorts/pacing', 'speaker-focus': '/api/speaker-focus' }[request.kind];
        try { task.results.push({ index, kind: request.kind, sourceId: request.request.sourceId, result: await service.api.analysis(route, request.request, AbortSignal.any([task.controller.signal, AbortSignal.timeout(2 * 60 * 60_000)]), progress => { saved.progress = { index, total: requests.length, progress }; }) }); }
        catch (error) { task.results.push({ index, kind: request.kind, sourceId: request.request.sourceId, error: (error as Error).message }); }
      }
      saved.status = task.controller.signal.aborted ? 'cancelled' : 'completed';
    })();
    return { analysisId: task.id, status: task.status, note: 'Analysis jobs live in this MCP server session. Poll get_analysis; reconnecting after a server restart requires a new job.' };
  });
  tool('get_analysis', 'Read progress and per-video results/errors from a started analysis batch.', z.object({ analysisId: id }).strict(), { readOnly: true }, ({ analysisId }) => { const task = analyses.get(analysisId); if (!task) throw new Error('Analysis not found in this MCP session.'); const { controller: _, ...result } = task; return result; });
  tool('cancel_analysis', 'Cancel a running analysis batch; completed per-video results remain available.', z.object({ analysisId: id }).strict(), {}, ({ analysisId }) => { const task = analyses.get(analysisId); if (!task) throw new Error('Analysis not found.'); task.controller.abort(); return { analysisId, cancellationRequested: true }; });
  tool('get_transcript', 'Read a cached source transcript with word timings. Use start_analysis to prepare it if absent.', z.object(source).strict(), { readOnly: true }, ({ sourceId }, signal) => get(`/api/shorts/transcript/${sourceId}`, signal));
  tool('check_clip_history', 'Compare proposed short-clip source cuts against export history before rendering.', draftHistorySchema, { readOnly: true }, (input, signal) => post('/api/shorts/review-history', input, signal));
  tool('preview_draft', 'Render the first five seconds of one source in an Auto or Manual draft, including readable embedded captions. Auto previews source picture settings before final Auto cuts, narration and generated captions. Returns a URL and embeddedText area report. Does not change the draft or create an export. Repeat for each bulk target to inspect lettering and area edges.', z.object({ draftId: id, revision: z.number().int().nonnegative(), sourceId: id }).strict(), {}, async ({ draftId, revision, sourceId }, signal) => {
    const draft = service.drafts.ready(draftId, revision);
    const item = draft.items.find(item => item.sourceId === sourceId);
    if (!item) throw new Error('Choose a source in this draft.');
    const [source] = await service.sourcesFor([sourceId], signal);
    const settings = item.settings ?? autoPicturePreview(item.options!, source);
    return renderPreview({ sourceId, settings }, signal);
  });
  tool('preview_manual', 'Render the first five seconds using full settings, including readable embedded captions, text and watermark masks. embeddedText reports the automatic/manual areas actually used. Returns a preview URL; does not queue a final export.', z.object({ ...source, settings: settingsSchema }).strict(), {}, (input, signal) => renderPreview(input, signal));

  tool('get_saved_edit', 'Read a saved export plan, editable caption/text IDs, cuts, footage, media and framing. Use preview_saved_edit or prompt_saved_edit before render_saved_edit.', z.object(job).strict(), { readOnly: true }, ({ jobId }, signal) => get(`/api/jobs/${jobId}/plan`, signal));
  tool('preview_saved_edit', 'Validate and preview saved-result changes without rendering or saving. Supports framing.speed (0.5–2) and framing.mirror (horizontal flip), framing.preserveEmbeddedText and framing.embeddedTextRegions, captions, independent text, footage, cuts, focus, styles and B-roll. Speed retimes saved captions and supporting shots. Return the full proposed plan.', z.object({ ...job, changes: editPlanChangesSchema, base: editPlanChangesSchema.optional() }).strict(), { readOnly: true }, ({ jobId, changes, base }, signal) => post(`/api/jobs/${jobId}/plan/preview`, base ? { base, changes } : changes, signal));
  tool('prompt_saved_edit', 'Ask the app AI for a saved-result edit proposal, including speed, horizontal flip, readable fixed embedded captions, title designs, text resizing/animation and bulk caption corrections. Paid provider; read-only proposal. draft carries pending changes; returned changes are relative to the saved plan.', z.object({ ...job, revision: z.number().int().nonnegative(), prompt, draft: editPlanChangesSchema.optional() }).strict(), { readOnly: true, external: true }, ({ jobId, ...body }, signal) => post(`/api/jobs/${jobId}/edit-prompt`, body, signal));
  tool('render_saved_edit', 'Render a reviewed saved-result revision only when the user requests an export. Creates a new export and may incur AI charges; keep the returned job ID to avoid duplicate submissions.', z.object({ ...job, changes: editPlanChangesSchema }).strict(), { external: true }, ({ jobId, changes }, signal) => post(`/api/jobs/${jobId}/revisions`, changes, signal));
  tool('get_saved_draft', 'Read the app’s persisted saved-result draft and concurrency token.', z.object(job).strict(), { readOnly: true }, ({ jobId }, signal) => get(`/api/jobs/${jobId}/draft`, signal));
  tool('save_saved_draft', 'Save a saved-result editor draft using the current token from get_saved_draft. content is JSON text containing {draft: the full plan from get_saved_edit}. Does not render; preserves server validation and concurrency checks.', z.object({ ...job, revision: z.number().int().nonnegative(), content: z.string().max(400000), token: z.string().nullable() }).strict(), {}, ({ jobId, ...body }, signal) => change(`/api/jobs/${jobId}/draft`, 'PUT', body, signal));
  tool('discard_saved_draft', 'Discard a saved-result editor draft when requested, retaining its rendered export.', z.object({ ...job, token: z.string() }).strict(), { destructive: true }, ({ jobId, token }, signal) => service.api.fetchJson(`/api/jobs/${jobId}/draft`, { method: 'DELETE', headers: { 'If-Match': token }, signal }));
  tool('get_source_status', 'Check whether a saved export’s original source is still available and discover matching reimported originals.', z.object(job).strict(), { readOnly: true }, ({ jobId }, signal) => get(`/api/jobs/${jobId}/source-status`, signal));
  tool('reconnect_source', 'Reconnect a saved export to a reimported unchanged original. The server verifies the source fingerprint.', z.object({ ...job, ...source }).strict(), {}, ({ jobId, sourceId }, signal) => post(`/api/jobs/${jobId}/reconnect`, { sourceId }, signal));
  tool('get_waveform', 'Read a saved edit’s audio waveform for timing and timeline inspection.', z.object(job).strict(), { readOnly: true }, ({ jobId }, signal) => get(`/api/jobs/${jobId}/waveform`, signal));
  tool('retry_export', 'Retry an explicitly requested failed/cancelled export; may incur provider charges. Returns the current job.', z.object(job).strict(), { external: true }, ({ jobId }, signal) => post(`/api/jobs/${jobId}/retry`, {}, signal));
  tool('review_export', 'Run editorial or finished-picture/sound review on a completed export. May incur provider charges; does not render another copy.', z.object({ ...job, kind: z.enum(['editorial', 'finished']) }).strict(), { external: true }, ({ jobId, kind }, signal) => post(`/api/jobs/${jobId}/${kind === 'editorial' ? 'editorial-review' : 'finished-review'}`, {}, signal));
  tool('get_export_review', 'Read the human review verdict and notes for an export.', z.object(job).strict(), { readOnly: true }, ({ jobId }, signal) => get(`/api/jobs/${jobId}/review`, signal));
  tool('set_export_review', 'Set acceptance, needs-edit or rejection and review notes for selected exports. Returns individual successes/errors; never implies the whole selection succeeded when one fails.', z.object({ jobIds: ids, review: quickReviewSchema }).strict(), {}, async ({ jobIds, review }, signal) => {
    const results = []; for (const jobId of jobIds) { try { results.push({ jobId, result: await change(`/api/jobs/${jobId}/review`, 'PATCH', review, signal) }); } catch (error) { results.push({ jobId, error: (error as Error).message }); } } return { results };
  });
  tool('rename_export', 'Set the download/display title of an export.', z.object({ ...job, title: z.string().trim().min(1).max(90) }).strict(), {}, ({ jobId, title }, signal) => change(`/api/jobs/${jobId}/title`, 'PATCH', { title }, signal));
  tool('keep_exports', 'Keep selected completed exports from automatic expiry as one validated batch.', z.object({ jobIds: ids }).strict(), {}, ({ jobIds }, signal) => change('/api/exports/keep', 'PATCH', { ids: jobIds }, signal));
  tool('release_export', 'Release Keep for one completed export, restoring normal retention.', z.object(job).strict(), {}, ({ jobId }, signal) => change(`/api/jobs/${jobId}/keep`, 'PATCH', { keep: false }, signal));
  tool('delete_exports', 'Delete explicitly requested exports and their saved editing files. Originals remain. Requires confirm:true; active jobs cannot be removed.', z.object({ jobIds: ids, confirm }).strict(), { destructive: true }, ({ jobIds, confirm }, signal) => change('/api/exports/selected', 'DELETE', { ids: jobIds, confirm }, signal));
  tool('get_download_links', 'Get local URLs for individual images, MP4, carousel image ZIPs, SRT and previews. downloadIds selects only those standalone posts for individual files and a combined ZIP; carousel images are grouped in numbered folders in slide order. Use list_downloads first to select ready IDs or all ready posts (up to 100). accepted:true requires jobIds and includes only accepted exports from that explicit selection. Files are fetched through the app, not embedded in tool output.', z.object({ jobId: id.optional(), batchId: id.optional(), jobIds: ids.optional(), downloadIds: ids.optional(), accepted: z.boolean().optional() }).strict().refine(input => !input.accepted || !!input.jobIds?.length, 'Choose jobIds for an accepted-export ZIP'), { readOnly: true }, input => ({
    ...(input.jobId ? { video: `${service.api.baseUrl}/api/jobs/${input.jobId}/download`, preview: `${service.api.baseUrl}/api/jobs/${input.jobId}/video`, captions: `${service.api.baseUrl}/api/jobs/${input.jobId}/captions`, thumbnail: `${service.api.baseUrl}/api/jobs/${input.jobId}/thumbnail` } : {}),
    ...(input.batchId ? { batch: `${service.api.baseUrl}/api/batches/${input.batchId}/download` } : {}),
    ...(input.jobIds ? { selected: `${service.api.baseUrl}/api/exports/selected.zip?${query({ ids: input.jobIds.join(',') })}` } : {}),
    ...(input.downloadIds ? { downloads: input.downloadIds.map(id => `${service.api.baseUrl}/api/downloads/${id}/file`), downloadThumbnails: input.downloadIds.map(id => `${service.api.baseUrl}/api/downloads/${id}/thumbnail`), downloadsZip: `${service.api.baseUrl}/api/downloads/selected.zip?${query({ ids: input.downloadIds.join(',') })}` } : {}),
    ...(input.accepted ? { accepted: `${service.api.baseUrl}/api/exports/accepted.zip?${query({ ids: input.jobIds!.join(',') })}` } : {}), note: 'Links work only while the requested files are retained and ready; SRT exists only for exports with added captions.' }));

  tool('list_history', 'Search the export library/history by source, project, verdict, publication status, aspect and dates.', z.object({ sourceId: id.optional(), limit: z.number().int().min(1).max(100).default(30), offset: z.number().int().nonnegative().default(0), search: z.string().max(200).optional(), review: z.enum(['all','unreviewed','accepted','needs-edit','rejected']).optional(), publication: z.enum(['all','unpublished','scheduled','published']).optional(), aspect: z.enum(['original','9:16','16:9','1:1','4:5']).optional(), project: project.optional(), after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(), before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional() }).strict(), { readOnly: true }, ({ sourceId, ...filters }, signal) => get(`${sourceId ? `/api/sources/${sourceId}/history` : '/api/history'}?${query(filters)}`, signal));
  tool('list_projects', 'List projects used in the source and export library.', empty, { readOnly: true }, (_, signal) => get('/api/library/projects', signal));
  tool('protect_sources', 'Keep explicit source videos from expiring while working on a draft. Use your MCP draft ID as ownerId. sourceIds is the full protected selection for that owner; [] releases only that owner’s pins.', z.object({ ownerId: id, sourceIds: z.array(id).max(200) }).strict(), {}, ({ ownerId, sourceIds }, signal) => change(`/api/draft-sources/${ownerId}`, 'PUT', { sourceIds }, signal));
  tool('release_source_protection', 'Explicitly release all draft-protection owners for one source so ordinary retention can resume. Requires confirmation because other drafts may use it.', z.object({ ...source, confirm }).strict(), { destructive: true }, ({ sourceId }, signal) => change(`/api/sources/${sourceId}/draft-protection`, 'DELETE', { release: true }, signal));
  tool('get_media_links', 'Get local preview URLs for a source, footage clip, history thumbnail, or media retained by a saved edit. IDs come from list_videos, list_footage, list_history or get_saved_edit.', z.object({ kind: z.enum(['source', 'footage', 'history', 'saved-media', 'saved-footage']), id, mediaId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/u).optional() }).strict(), { readOnly: true }, ({ kind, id, mediaId }) => {
    if (kind === 'saved-media' || kind === 'saved-footage') {
      if (!mediaId) throw new Error('Supply the media/asset ID from the saved plan.');
      return { video: `${service.api.baseUrl}/api/jobs/${id}/${kind === 'saved-media' ? 'plan/media' : 'footage'}/${encodeURIComponent(mediaId)}` };
    }
    const route = { source: 'sources', footage: 'broll', history: 'history' }[kind];
    return { thumbnail: `${service.api.baseUrl}/api/${route}/${id}/thumbnail`, ...(kind !== 'history' ? { video: `${service.api.baseUrl}/api/${route}/${id}/video` } : {}) };
  });
  tool('set_project', 'Assign selected sources or saved history entries to a project; empty text removes the project. Reports each result separately.', z.object({ kind: z.enum(['source', 'history']), ids, project }).strict(), {}, async ({ kind, ids, project }, signal) => { const results = []; for (const id of ids) { try { results.push({ id, result: await change(`/api/${kind === 'source' ? 'sources' : 'history'}/${id}/project`, 'PATCH', { project }, signal) }); } catch (error) { results.push({ id, error: (error as Error).message }); } } return { results }; });
  tool('get_measurements', 'Read quality/workflow measurements and optionally all history records. Includes JSON/CSV export URLs.', z.object({ includeEntries: z.boolean().default(false) }).strict(), { readOnly: true }, async ({ includeEntries }, signal) => ({ data: await get(includeEntries ? '/api/measurements/export?format=json' : '/api/measurements', signal), json: `${service.api.baseUrl}/api/measurements/export?format=json`, csv: `${service.api.baseUrl}/api/measurements/export?format=csv` }));
  tool('set_measurements', 'Record user-supplied workflow review and platform performance metrics for one history entry.', z.object({ historyId: id, measurements: measurementsSchema }).strict(), {}, ({ historyId, measurements }, signal) => change(`/api/history/${historyId}/measurements`, 'PATCH', measurements, signal));
  tool('set_publication_records', 'Record already-published posts and their URLs in export history. Does not publish or schedule anything.', z.object({ historyId: id, records: publicationChangesSchema }).strict(), {}, ({ historyId, records }, signal) => change(`/api/history/${historyId}`, 'PATCH', records, signal));
  tool('get_provider_status', 'Read configured-provider status without returning credentials. API keys are entered in the app’s local Settings.', empty, { readOnly: true }, (_, signal) => get('/api/settings/api-keys', signal));
  tool('test_provider', 'Test an already configured provider connection without reading or accepting its API key.', z.object({ provider: z.enum(API_PROVIDERS) }).strict(), { readOnly: true, external: true }, ({ provider }, signal) => service.api.fetchJson(`/api/settings/api-keys/${provider}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-remix-settings': '1' }, body: '{}', signal }, 65_000));
  tool('get_local_models', 'Check local AI upscale and watermark-removal installation status.', empty, { readOnly: true }, async (_, signal) => ({ upscale: await get('/api/upscale/capabilities', signal), watermark: await get('/api/watermark/setup', signal) }));

  tool('get_publishing', 'Read publishing configuration/profiles, connected channels, or scheduled/publication records. Never returns provider secrets.', z.object({ section: z.enum(['config', 'channels', 'publications']), jobId: id.optional(), offset: z.number().int().min(0).max(1000000).default(0) }).strict(), { readOnly: true, external: true }, ({ section, jobId, offset }, signal) => get(`/api/publishing/${section}${section === 'publications' ? `?${query({ jobId, offset })}` : ''}`, signal));
  tool('save_promotion_profile', 'Save a product/app promotion profile used for post copy generation.', z.object({ profile: promotionProfileSchema }).strict(), {}, ({ profile }, signal) => change(`/api/publishing/profiles/${profile.id}`, 'PUT', profile, signal));
  tool('import_store_profile', 'Import a promotion profile from a supported app-store URL. Contacts the store and does not publish.', appStoreImportSchema, { external: true }, (input, signal) => post('/api/publishing/profiles/import-store', input, signal));
  tool('get_post_draft', 'Read the post title, short/long copy and hashtags for an export and platform.', z.object({ ...job, platform: platformSchema }).strict(), { readOnly: true }, ({ jobId, platform }, signal) => get(`/api/publishing/jobs/${jobId}/draft?${query({ platform })}`, signal));
  const copySchema = postDraftSchema.pick({ platform: true, title: true, short: true, long: true, hashtags: true, selected: true }).strict();
  tool('save_post_draft', 'Save reviewed post copy without scheduling or publishing it.', z.object({ ...job, copy: copySchema }).strict(), {}, ({ jobId, copy }, signal) => change(`/api/publishing/jobs/${jobId}/draft`, 'PUT', copy, signal));
  tool('generate_post_copy', 'Generate post copy for a chosen export/profile/platform/language. Uses configured AI and may incur charges. Does not publish.', z.object({ ...job, platform: platformSchema, profileId: id, language: languageNameSchema.optional() }).strict(), { external: true }, ({ jobId, ...body }, signal) => post(`/api/publishing/jobs/${jobId}/generate`, body, signal));
  tool('schedule_posts', 'Schedule reviewed post content to explicit connected channels through Postiz ONLY when the user explicitly requests scheduling/publishing. Can send live posts. Supply the reviewed content, date, per-channel settings and stable requestId values; retries must reuse requestIds. Returns each channel’s success/error; never blindly retry uncertain posts.', z.object({ ...job, batch: crossPostSchema, confirm }).strict(), { external: true, destructive: true }, ({ jobId, batch }, signal) => post(`/api/publishing/jobs/${jobId}/schedule-batch`, batch, signal, 150_000));
  tool('refresh_publication', 'Refresh a publication’s actual Postiz status before retrying or cancelling.', z.object({ publicationId: id }).strict(), { external: true }, ({ publicationId }, signal) => post(`/api/publishing/publications/${publicationId}/refresh`, {}, signal));
  tool('cancel_publication', 'Cancel an explicitly requested scheduled/draft post. Does not remove a post already published on the platform.', z.object({ publicationId: id, confirm }).strict(), { external: true, destructive: true }, ({ publicationId }, signal) => change(`/api/publishing/publications/${publicationId}`, 'DELETE', undefined, signal));
  tool('resolve_publication', 'Resolve an uncertain publication only after the user has confirmed it is absent in Postiz. Never infer absence from a timeout or failed refresh.', z.object({ publicationId: id, confirmedAbsentInPostiz: z.literal(true) }).strict(), { destructive: true }, ({ publicationId, confirmedAbsentInPostiz }, signal) => post(`/api/publishing/publications/${publicationId}/resolve`, { confirmedAbsentInPostiz }, signal));
}
