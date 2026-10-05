import type { EditSegment } from './types.js';
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
/** Move or trim one interval while keeping it within its lane and available media. */
export function shiftTimelineInterval(item: { start: number; end: number }, delta: number, mode: 'move' | 'start' | 'end', bounds: { low: number; high: number; minimum: number; maxLength?: number }) {
  const length = item.end - item.start;
  if (mode === 'move') { const start = clamp(item.start + delta, bounds.low, bounds.high - length); return { start, end: start + length }; }
  if (mode === 'start') return { start: clamp(item.start + delta, Math.max(bounds.low, item.end - (bounds.maxLength ?? Infinity)), item.end - bounds.minimum), end: item.end };
  return { start: item.start, end: clamp(item.end + delta, item.start + bounds.minimum, Math.min(bounds.high, item.start + (bounds.maxLength ?? Infinity))) };
}
