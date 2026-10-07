import { manualPreviewInterval, manualSequencePreview } from './manual.js';
import { footageTimeline, ownFootageSchema, resolveFootagePlacement, type OwnFootageAsset, type OwnFootagePlacement } from './own-footage.js';
import type { FocalPoint, RemixSettings } from './types.js';

export interface FootagePreviewSegment {
  kind: 'source' | 'insert' | 'cover';
  start: number;
  end: number;
  /** Time on the edit before inserts, for captions and source audio. */
  baseStart: number;
  sourceStart: number;
  sourceRate: number;
  mediaStart: number;
  mediaRate: number;
  focalPoint?: FocalPoint;
  placement?: OwnFootagePlacement;
  asset?: OwnFootageAsset;
}
export interface FootagePreviewTimeline { segments: FootagePreviewSegment[]; duration: number }

/** Use the export engine's insertion clock; cover shots keep the source audio
 * running, while an insertion pauses both the base picture and its audio. */
export function buildFootagePreview(source: { duration: number; fps: number }, placements: OwnFootagePlacement[], assets: OwnFootageAsset[], settings?: RemixSettings): FootagePreviewTimeline {
  const sequence = settings && manualSequencePreview(settings, source.duration);
  const interval = settings && !settings.segments ? manualPreviewInterval(settings, source.duration) : null;
  if (settings && !sequence && !interval) throw new Error('Choose valid source cuts or trim times to preview this edit.');
  const rate = settings?.speed ?? 1;
  const cuts = sequence?.cuts ?? [{ start: interval?.start ?? 0, end: interval?.end ?? source.duration, focalPoint: settings?.focalPoint }];
  let baseDuration = 0;
  const base = cuts.map(cut => {
    const start = baseDuration;
    baseDuration += (cut.end - cut.start) / rate;
    return { ...cut, outputStart: start, outputEnd: baseDuration };
  });
  if (!(baseDuration > 0) || !Number.isFinite(baseDuration)) throw new Error('The source video has no playable duration.');
  const parsed = ownFootageSchema.safeParse(placements);
  if (!parsed.success) throw new Error('Check the added clips’ start, end and placement times. Cover shots cannot overlap.');
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const resolved = parsed.data.map(item => {
    const asset = byId.get(item.assetId);
    if (!asset) throw new Error('An added clip is unavailable. Choose it again in Add my own footage.');
    const placement = resolveFootagePlacement(item, asset.duration);
    if (placement.end > asset.duration + 0.001 || placement.end <= placement.start) throw new Error('An added clip’s trim extends beyond its video. Check its start and end.');
    return placement;
  });
  const fps = settings?.fps && settings.fps !== 'source' ? Number(settings.fps) : source.fps || 30;
  const { inserts, covers } = footageTimeline(resolved, baseDuration, fps);
  const boundaries = [...new Set([0, baseDuration, ...base.flatMap(cut => [cut.outputStart, cut.outputEnd]),
    ...inserts.map(item => item.at), ...covers.flatMap(item => [item.at, item.at + item.length])])].sort((a, b) => a - b);
  const segments: FootagePreviewSegment[] = [];
  let clock = 0;
  const add = (length: number, value: Omit<FootagePreviewSegment, 'start' | 'end'>) => {
    if (length <= 1e-8) return;
    segments.push({ ...value, start: clock, end: clock + length }); clock += length;
  };
  for (const [index, at] of boundaries.entries()) {
    for (const item of inserts.filter(item => item.at === at)) add(item.length, {
      kind: 'insert', baseStart: at, sourceStart: 0, sourceRate: rate, mediaStart: item.start, mediaRate: 1,
      placement: item, asset: byId.get(item.assetId),
    });
    const end = boundaries[index + 1];
    if (end === undefined || end - at < 1e-8) continue;
    const cut = base.find(cut => at >= cut.outputStart - 1e-8 && at < cut.outputEnd - 1e-8)!;
    const cover = covers.find(item => at >= item.at - 1e-8 && at < item.at + item.length - 1e-8);
    const sourceStart = cut.start + (at - cut.outputStart) * rate;
    add(end - at, {
      kind: cover ? 'cover' : 'source', baseStart: at, sourceStart, sourceRate: rate,
      mediaStart: cover ? cover.start + at - cover.at : sourceStart, mediaRate: cover ? 1 : rate,
      focalPoint: cut.focalPoint, placement: cover, asset: cover ? byId.get(cover.assetId) : undefined,
    });
  }
  return { segments, duration: clock };
}

export function footagePreviewPosition(timeline: FootagePreviewTimeline, time: number) {
  const index = timeline.segments.findIndex(segment => time < segment.end - 1e-8);
  const segmentIndex = index < 0 ? timeline.segments.length - 1 : index;
  const segment = timeline.segments[segmentIndex]!;
  const offset = Math.max(0, Math.min(segment.end - segment.start, time - segment.start));
  return { segment, segmentIndex, offset, mediaTime: segment.mediaStart + offset * segment.mediaRate,
    sourceTime: segment.sourceStart + offset * segment.sourceRate, baseTime: segment.baseStart + offset };
}
