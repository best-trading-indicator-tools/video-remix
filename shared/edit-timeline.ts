import type { EditPlan, EditSegment } from './types.js';
import { withTrackBounds } from './focus.js';
import { footageTimeline, type OwnFootagePlacement } from './own-footage.js';
export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(Math.max(low, high), value));
export function cutTimeline(cuts: EditSegment[], speed: number) {
  let offset = 0;
  return cuts.map((cut, index) => { const start = offset; offset += (cut.end - cut.start) / speed; return { ...cut, index, outputStart: start, outputEnd: offset }; });
}
export function sourceAtTime(cuts: EditSegment[], speed: number, time: number) {
  const timeline = cutTimeline(cuts, speed);
  const cut = timeline.find(cut => time < cut.outputEnd) ?? timeline.at(-1)!;
  return { index: cut.index, time: clamp(cut.start + (time - cut.outputStart) * speed, cut.start, cut.end) };
}
export function splitTimelineCut(cuts: EditSegment[], speed: number, time: number): EditSegment[] {
  if (cuts.length >= 60) throw new Error('An edit can contain at most 60 cuts.');
  const point = sourceAtTime(cuts, speed, time), cut = cuts[point.index]!;
  if (point.time - cut.start < 0.04 || cut.end - point.time < 0.04) throw new Error('Place the playhead inside a cut, at least one frame from its edges.');
  return cuts.flatMap((cut, index) => index === point.index ? [{ ...cut, end: point.time }, { ...cut, start: point.time }] : [cut]);
}

export type StoryClip = { id: string; kind: 'cut'; cut: EditSegment } | { id: string; kind: 'footage'; footage: OwnFootagePlacement };
export const clipLength = (clip: StoryClip, speed: number) => clip.kind === 'cut' ? (clip.cut.end - clip.cut.start) / speed : clip.footage.end - clip.footage.start;
export function storyTiming(clips: StoryClip[], speed: number) {
  let offset = 0, main = 0;
  return clips.map(clip => {
    const start = offset, mainStart = main;
    offset += clipLength(clip, speed);
    if (clip.kind === 'cut') main += clipLength(clip, speed);
    return { ...clip, outputStart: start, outputEnd: offset, mainStart, mainEnd: main };
  });
}

/** The same clock as the rendered movie, including inserts and full-length outros. */
export function storyClips(plan: EditPlan, fps = 30): StoryClip[] {
  const cuts = cutTimeline(plan.cuts, plan.settings.speed), duration = cuts.at(-1)?.outputEnd ?? 0;
  const { inserts } = footageTimeline(plan.settings.ownFootage, duration, fps);
  const result: StoryClip[] = [];
  let nextInsert = 0;
  const insertThrough = (time: number) => {
    while (nextInsert < inserts.length && inserts[nextInsert]!.at <= time + 1e-7) {
      const item = inserts[nextInsert++]!;
      const { length: _length, ...placement } = item;
      result.push({ id: item.id, kind: 'footage', footage: placement });
    }
  };
  for (const cut of cuts) {
    const edges = [...new Set([cut.outputStart, ...inserts.filter(item => item.at > cut.outputStart && item.at < cut.outputEnd).map(item => item.at), cut.outputEnd])];
    for (let i = 0; i < edges.length - 1; i++) {
      insertThrough(edges[i]!);
      result.push({ id: `cut:${cut.index}:${i}`, kind: 'cut', cut: withTrackBounds({ ...plan.cuts[cut.index]!, start: cut.start + (edges[i]! - cut.outputStart) * plan.settings.speed, end: cut.start + (edges[i + 1]! - cut.outputStart) * plan.settings.speed }) });
    }
  }
  insertThrough(duration);
  return result;
}

export function storyChanges(clips: StoryClip[], plan: EditPlan) {
  const cuts: EditSegment[] = [], ownFootage = (plan.settings.ownFootage ?? []).filter(item => item.mode === 'cover');
  let main = 0;
  for (const clip of clips) {
    if (clip.kind === 'cut') { cuts.push(withTrackBounds(clip.cut)); main += clipLength(clip, plan.settings.speed); }
    else ownFootage.push({ ...clip.footage, at: main, appendToEnd: false });
  }
  if (!cuts.length) throw new Error('Keep at least one clip from the main video.');
  if (cuts.length > 60) throw new Error('An edit can contain at most 60 main clips.');
  if (ownFootage.length > 20) throw new Error('An edit can contain at most 20 uploaded clips.');
  return { cuts, ownFootage };
}

export function splitStory(clips: StoryClip[], speed: number, time: number, id: string): StoryClip[] {
  const index = storyTiming(clips, speed).findIndex(clip => time > clip.outputStart + 1e-7 && time < clip.outputEnd - 1e-7);
  if (index < 0) throw new Error('Place the playhead inside a clip to split it.');
  const clip = clips[index]!, start = storyTiming(clips, speed)[index]!.outputStart;
  const interval = clip.kind === 'cut' ? clip.cut : clip.footage;
  const point = interval.start + (time - start) * (clip.kind === 'cut' ? speed : 1), minimum = clip.kind === 'cut' ? 0.04 : 0.1;
  if (point - interval.start < minimum - 1e-9 || interval.end - point < minimum - 1e-9) throw new Error('Move the playhead farther from the clip edge.');
  const parts: StoryClip[] = clip.kind === 'cut'
    ? [{ ...clip, cut: withTrackBounds({ ...clip.cut, end: point }) }, { ...clip, id, cut: withTrackBounds({ ...clip.cut, start: point }) }]
    : [{ ...clip, footage: { ...clip.footage, end: point, appendToEnd: false } }, { ...clip, id, footage: { ...clip.footage, id, start: point, appendToEnd: false } }];
  return [...clips.slice(0, index), ...parts, ...clips.slice(index + 1)];
}

/** Insert at the playhead, splitting the destination clip when necessary. */
export function pasteStory(clips: StoryClip[], copied: StoryClip[], speed: number, time: number, makeId: () => string): StoryClip[] {
  const duration = storyTiming(clips, speed).at(-1)?.outputEnd ?? 0;
  time = clamp(time, 0, duration);
  let destination = clips;
  const boundary = storyTiming(clips, speed).some(clip => Math.abs(clip.outputStart - time) < 1e-7 || Math.abs(clip.outputEnd - time) < 1e-7);
  if (!boundary) destination = splitStory(clips, speed, time, makeId());
  const index = storyTiming(destination, speed).findIndex(clip => clip.outputStart >= time - 1e-7);
  const copies = copied.map(clip => {
    const id = makeId();
    return clip.kind === 'cut' ? { ...structuredClone(clip), id } : { ...structuredClone(clip), id, footage: { ...clip.footage, id, appendToEnd: false } };
  });
  return [...destination.slice(0, index < 0 ? destination.length : index), ...copies, ...destination.slice(index < 0 ? destination.length : index)];
}

export function mainTimeAt(clips: StoryClip[], speed: number, time: number) {
  const timed = storyTiming(clips, speed), clip = timed.find(item => time < item.outputEnd) ?? timed.at(-1);
  return clip ? clip.mainStart + (clip.kind === 'cut' ? clamp(time - clip.outputStart, 0, clip.outputEnd - clip.outputStart) : 0) : 0;
}
export function outputTimeAt(clips: StoryClip[], speed: number, mainTime: number, edge: 'start' | 'end' = 'start') {
  const timed = storyTiming(clips, speed);
  const clip = timed.find(item => item.kind === 'cut' && (edge === 'end' ? mainTime <= item.mainEnd + 1e-7 : mainTime < item.mainEnd - 1e-7));
  return clip ? clip.outputStart + clamp(mainTime - clip.mainStart, 0, clip.outputEnd - clip.outputStart) : timed.at(-1)?.outputEnd ?? 0;
}
export function timecode(time: number, fps = 30) {
  const frames = Math.max(0, Math.round(time * fps)), rate = Math.round(fps);
  return [Math.floor(frames / rate / 3600), Math.floor(frames / rate / 60) % 60, Math.floor(frames / rate) % 60, frames % rate].map(value => String(value).padStart(2, '0')).join(':');
}
/** Move or trim one interval while keeping it within its lane and available media. */
export function shiftTimelineInterval(item: { start: number; end: number }, delta: number, mode: 'move' | 'start' | 'end', bounds: { low: number; high: number; minimum: number; maxLength?: number }) {
  const length = item.end - item.start;
  if (mode === 'move') { const start = clamp(item.start + delta, bounds.low, bounds.high - length); return { start, end: start + length }; }
  if (mode === 'start') return { start: clamp(item.start + delta, Math.max(bounds.low, item.end - (bounds.maxLength ?? Infinity)), item.end - bounds.minimum), end: item.end };
  return { start: item.start, end: clamp(item.end + delta, item.start + bounds.minimum, Math.min(bounds.high, item.start + (bounds.maxLength ?? Infinity))) };
}
