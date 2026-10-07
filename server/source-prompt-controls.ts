import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { blackBandsSchema, DEFAULT_BLACK_BANDS } from '../shared/black-bands.js';
import { captionStyleSchema } from '../shared/caption-style.js';
import { ownFootageSchema, resolveFootagePlacement } from '../shared/own-footage.js';
import { getVisualSources, VISUAL_SOURCE_LABELS } from '../shared/visual-sources.js';
import type { RemixSettings, SupportingVisualOptions } from '../shared/types.js';
import { settingsSchema } from './schema.js';
import { PromptEditError } from './prompt-edit.js';

export interface PromptAssets {
  videos: { id: string; name: string; duration: number }[];
  attachments: { id: string; name: string; kind: 'audio' | 'subtitle' }[];
}
export const EMPTY_PROMPT_ASSETS: PromptAssets = { videos: [], attachments: [] };
const ref = z.string().regex(/^(video|audio|subtitle)[1-9]\d*$/u);
const footageItem = z.object(ownFootageSchema.element.shape).omit({ id: true, assetId: true }).extend({ asset: ref }).strict();
export const sourcePromptShape = {
  blackBands: z.object(blackBandsSchema.shape).partial().strict().optional(),
  captionStyle: captionStyleSchema.partial().strict().optional(),
  visualSources: settingsSchema.shape.visualSources,
  stockVideoType: settingsSchema.shape.stockVideoType,
  brollMatching: settingsSchema.shape.brollMatching,
  brollCount: settingsSchema.shape.brollCount,
  brollMaxCoverage: settingsSchema.shape.brollMaxCoverage,
  brollClips: z.array(ref).max(100).optional(),
  footage: z.array(footageItem).max(20).optional(),
};
export const sourcePromptInstructions = `
Common editing controls in both workspaces:
blackBands is a sparse object: enabled boolean, fit contain/crop, topPercent and bottomPercent each 10–40 (sum at most 70), topText and bottomText up to 200 printable characters, fontPercent 3–10. Enable bands when adding them; defaults are top 25%, bottom 15%, font 5.4%, contain. Preserve text and dimensions not requested. Text must be supplied literally in the request; no speech has been analyzed here.
captionStyle is a sparse object: fontSize 12–40, bottomPercent 5–80 (larger moves UP), fontFamily classic/poppins/anton/serif; color, outlineColor, backgroundColor six-digit #RRGGBB; bold, italic, uppercase booleans; outlineWidth/shadow 0–5; letterSpacing 0–4; alignment left/center/right; background none/box; backgroundOpacity 0–100; wordHighlight boolean and highlightColor six-digit #RRGGBB highlight each spoken word. Only added captions can be styled.
visualSources is the complete desired list from pixabay, pexels, hyperframes, remotion, library. [] removes supporting visuals. Preserve selected sources unless removal is requested. For a generic request to add B-roll with no sources selected, choose a configured stock provider from availableStockProviders; if none exists, ask which provider to configure or which uploaded clip to use. HyperFrames and Remotion create supporting animations; library uses uploaded B-roll. brollCount 1–10 is the total requested shot count (default 4); add N more increases the current count by N, or starts at N if visuals were off. brollMaxCoverage 0–100 limits coverage. stockVideoType all/animation; brollMatching tags/ai (stock always uses ai). brollClips is the complete desired list of video references from assets; include library in visualSources when selecting clips. Footage and stock matching are performed during export using the selected speech, never claim to have searched or rendered. Subject-specific stock search independent of the speech is unavailable.
footage is the complete desired list of uploaded-clip placements, [] removes them: [{asset:'video1',mode:'insert'|'cover',appendToEnd:false,at:0,start:0,end:5,audio:'clip'|'mute',fit:'contain'|'crop'}]. Preserve existing placements when adding. at uses the main edit's clock before inserts. Insert adds duration; cover replaces the picture while main speech continues. appendToEnd:true requires insert and uses the full asset; use at:0,start:0,end:asset.duration. Intervals must fit the asset; cover shots cannot overlap. Only references in the supplied assets catalog may be used. If an asset is missing or ambiguous, request its upload/selection by name. Never invent asset references or use paths/URLs.
layout single/split/presentation and secondaryFocalPoint {x:0..1,y:0..1} are Manual controls; smoothCuts boolean enables small audio fades at cut boundaries.
`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const cleanName = (name: string) => name.split(/[/\\]/u).at(-1)!.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 100);
export function promptAssetCatalog(assets: PromptAssets) {
  return [
    ...assets.videos.map((asset, i) => ({ ref: `video${i + 1}`, name: cleanName(asset.name), duration: asset.duration })),
    ...assets.attachments.map((asset, i) => ({ ref: `${asset.kind}${i + 1}`, name: cleanName(asset.name), kind: asset.kind })),
  ];
}
export function attachmentFromRef(value: string | null, kind: 'audio' | 'subtitle', assets: PromptAssets) {
  if (value === null) return null;
  const asset = assets.attachments.find((item, i) => item.kind === kind && `${item.kind}${i + 1}` === value);
  if (!asset) throw new PromptEditError(422, `The requested ${kind === 'audio' ? 'audio' : 'caption'} file is unavailable. Upload it before applying the prompt.`);
  return asset.id;
}
export function sourcePromptContext<T extends SupportingVisualOptions & Pick<RemixSettings, 'ownFootage' | 'watermarkRemoval'>>(settings: T, assets: PromptAssets) {
  const { brollIds, ownFootage, watermarkRemoval: _watermarkRemoval, ...current } = settings;
  return { ...current, visualSources: getVisualSources(settings), brollClips: brollIds?.map(id => {
    const index = assets.videos.findIndex(asset => asset.id === id); return index < 0 ? 'unavailable' : `video${index + 1}`;
  }), footage: ownFootage?.map(({ id: _id, assetId, ...item }) => ({ ...item,
    asset: `video${assets.videos.findIndex(asset => asset.id === assetId) + 1}`,
  })) };
}
type SharedPatch = z.infer<z.ZodObject<typeof sourcePromptShape>>;
export function applySourcePrompt<T extends SupportingVisualOptions & Pick<RemixSettings, 'blackBands' | 'captionStyle' | 'ownFootage'>>(current: T, patch: SharedPatch, assets: PromptAssets): T {
  const { blackBands, captionStyle, footage, brollClips, ...simple } = patch;
  const next = { ...structuredClone(current), ...simple };
  if (blackBands) next.blackBands = blackBandsSchema.parse({ ...DEFAULT_BLACK_BANDS, ...current.blackBands, ...blackBands });
  if (captionStyle) next.captionStyle = captionStyleSchema.parse({ fontSize: 20, bottomPercent: 100 / 12, ...current.captionStyle, ...captionStyle });
  const video = (reference: string) => {
    const asset = assets.videos.find((_, i) => `video${i + 1}` === reference);
    if (!asset) throw new PromptEditError(422, 'A requested video is unavailable. Add it to your footage library first.');
    return asset;
  };
  if (brollClips) next.brollIds = [...new Set(brollClips.map(reference => video(reference).id))];
  if (footage) next.ownFootage = ownFootageSchema.parse(footage.map(({ asset: reference, ...item }, index) => {
    const asset = video(reference);
    const resolved = resolveFootagePlacement({ ...item, assetId: asset.id,
      id: current.ownFootage?.[index]?.assetId === asset.id ? current.ownFootage[index]!.id : randomUUID() }, asset.duration);
    if (resolved.end > asset.duration + 0.001 || resolved.end - resolved.start < 0.1)
      throw new PromptEditError(422, `Choose a valid interval within “${cleanName(asset.name)}”.`);
    return resolved;
  }));
  return next;
}
export function sourcePromptSummary(before: Parameters<typeof applySourcePrompt>[0], after: Parameters<typeof applySourcePrompt>[0], assets: PromptAssets): string[] {
  const summary: string[] = [];
  if (!same(before.blackBands, after.blackBands)) {
    const bands = after.blackBands!;
    summary.push(bands.enabled ? `Black bands: top ${bands.topPercent}%, bottom ${bands.bottomPercent}%, ${bands.fit === 'contain' ? 'keep the whole picture' : 'fill the window'}, text size ${bands.fontPercent}%.` : 'Black bands: off.');
    if (before.blackBands?.topText !== bands.topText) summary.push(`Top band text: ${bands.topText ? `“${bands.topText}”` : 'none'}.`);
    if (before.blackBands?.bottomText !== bands.bottomText) summary.push(`Bottom band text: ${bands.bottomText ? `“${bands.bottomText}”` : 'none'}.`);
  }
  if (!same(getVisualSources(before), getVisualSources(after))) summary.push(`Supporting visuals: ${getVisualSources(after).map(key => VISUAL_SOURCE_LABELS[key]).join(', ') || 'off'}.`);
  for (const [key, label] of [['brollCount', 'Requested supporting shots'], ['brollMaxCoverage', 'Maximum supporting coverage (%)'], ['brollMatching', 'B-roll matching'], ['stockVideoType', 'Stock video type']] as const)
    if (before[key] !== after[key]) summary.push(`${label}: ${after[key]}.`);
  if (!same(before.brollIds, after.brollIds)) summary.push(`Selected B-roll: ${after.brollIds?.map(id => cleanName(assets.videos.find(asset => asset.id === id)?.name || 'Unavailable clip')).join(', ') || 'none'}.`);
  if (!same(before.ownFootage, after.ownFootage)) {
    if (!after.ownFootage?.length) summary.push('Remove all uploaded footage placements.');
    else after.ownFootage.forEach((item, i) => summary.push(`Footage ${i + 1}: ${cleanName(assets.videos.find(asset => asset.id === item.assetId)?.name || 'Uploaded clip')}, ${item.appendToEnd ? 'append the whole clip' : `${item.mode} at ${item.at}s, source ${item.start}–${item.end}s`}, ${item.audio === 'clip' ? 'clip audio' : 'muted'}, ${item.fit}.`));
  }
  return summary;
}
export function hasUngroundedBandText(patch: SharedPatch, before: Parameters<typeof applySourcePrompt>[0], prompt: string) {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return (['topText', 'bottomText'] as const).some(key => {
    const value = patch.blackBands?.[key];
    return value?.trim() && value !== before.blackBands?.[key] && !normalize(prompt).includes(normalize(value));
  });

}
