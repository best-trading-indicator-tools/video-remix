import type { FocalPoint } from "./types.js";
import type { shortCropGuide } from "./shorts.js";

export type CropGuide = ReturnType<typeof shortCropGuide>;
export interface MediaRectangle { left: number; top: number; width: number; height: number }

/** The visible picture inside an object-fit: contain video element. */
export function containedMediaRectangle(boxWidth: number, boxHeight: number, mediaWidth: number, mediaHeight: number): MediaRectangle | null {
  if (![boxWidth, boxHeight, mediaWidth, mediaHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(boxWidth / mediaWidth, boxHeight / mediaHeight);
  const width = mediaWidth * scale, height = mediaHeight * scale;
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}

/** Start from the visible crop center, even when an older focal value was clamped. */
export const visibleCropCenter = (crop: CropGuide): FocalPoint => ({ x: crop.left + crop.width / 2, y: crop.top + crop.height / 2 });

/** Pointer displacement is measured against the picture, never its letterboxing. */
export function dragCropPoint(crop: CropGuide, start: FocalPoint, dx: number, dy: number, picture: Pick<MediaRectangle, "width" | "height">): FocalPoint {
  const move = (axis: "x" | "y", delta: number, size: number) => {
    const movable = axis === "x" ? crop.canMoveX : crop.canMoveY;
    if (!movable || !Number.isFinite(delta) || !Number.isFinite(size) || size <= 0) return start[axis];
    const min = axis === "x" ? crop.minX : crop.minY;
    const max = axis === "x" ? crop.maxX : crop.maxY;
    return Math.max(min, Math.min(max, start[axis] + delta / size));
  };
  return { x: move("x", dx, picture.width), y: move("y", dy, picture.height) };
}
