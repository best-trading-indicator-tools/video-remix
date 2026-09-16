import type { EditSegment, FocalPoint, FocusKeyframe } from "./types.js";

export const MAX_FOCUS_POINTS_PER_CUT = 120;
export const MAX_FOCUS_POINTS_TOTAL = 240;

/** Keyframes use the original source clock, independently for every cut. */
export function validFocusTrack(track: unknown, start: number, end: number): track is FocusKeyframe[] | undefined {
  if (track === undefined) return true;
  return Array.isArray(track) && track.length > 0 && track.length <= MAX_FOCUS_POINTS_PER_CUT &&
    track.every((point, index) => point && typeof point === "object" && !Array.isArray(point) &&
      Number.isFinite(point.time) && point.time >= start && point.time <= end &&
      [point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
      (!index || point.time > track[index - 1].time));
}

/** Hold the nearest endpoint outside a track; interpolate within it. */
export function focusPointAt(track: readonly FocusKeyframe[] | undefined, time: number, fallback: FocalPoint): FocalPoint {
  if (!track?.length || !Number.isFinite(time)) return { ...fallback };
  const first = track[0]!, last = track.at(-1)!;
  if (time <= first.time) return { x: first.x, y: first.y };
  if (time >= last.time) return { x: last.x, y: last.y };
  const right = track.findIndex(point => point.time >= time);
  const before = track[right - 1]!, after = track[right]!;
  const fraction = (time - before.time) / (after.time - before.time);
  return { x: before.x + (after.x - before.x) * fraction, y: before.y + (after.y - before.y) * fraction };
}

/** Trim without restarting the camera motion or interpolating across a cut. */
export function clipFocusTrack(track: readonly FocusKeyframe[] | undefined, start: number, end: number): FocusKeyframe[] | undefined {
  if (!track?.length || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const first = track[0]!, last = track.at(-1)!;
  const result = track.filter(point => point.time >= start && point.time <= end).map(point => ({ ...point }));
  const boundary = (time: number) => ({ time, ...focusPointAt(track, time, first) });
  if (start > first.time && start < last.time && !result.some(point => point.time === start)) result.unshift(boundary(start));
  if (end > first.time && end < last.time && !result.some(point => point.time === end)) result.push(boundary(end));
  // A wholly extended interval has a constant nearest endpoint. No extra
  // boundary points are needed outside observations because endpoints hold.
  if (!result.length) result.push(boundary(start));
  return result;
}

export function withTrackBounds<T extends EditSegment>(segment: T): T {
  if (!segment.focusTrack || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end < segment.start) return { ...segment };
  return { ...segment, focusTrack: clipFocusTrack(segment.focusTrack, segment.start, segment.end) };
}
