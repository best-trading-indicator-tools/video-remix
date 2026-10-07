import { z } from "zod";

export const MAX_WATERMARK_MASKS = 16;
export const MAX_MASK_STROKES = 100;
export const MAX_STROKE_POINTS = 300;
export const MAX_MASK_POINTS = 8000;
export const DEFAULT_WATERMARK_FEATHER = .01;
const coordinate = z.number().finite().min(0).max(1);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const stroke = z.object({
  kind: z.enum(["brush", "erase", "rect"]),
  /** Diameter as a fraction of the source's shorter dimension. */
  size: z.number().finite().min(.005).max(.2),
  points: z.array(point).min(1).max(MAX_STROKE_POINTS),
}).strict().refine(value => value.kind !== "rect" || value.points.length === 2, "A selection needs two corners");
export const watermarkRemovalSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["fixed", "timed"]),
  /** Soft transition outside the painted mask, relative to the shorter source dimension. */
  feather: z.number().finite().min(0).max(.03).optional(),
  masks: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
    /** Always original-source seconds, before trims, cuts, speed and inserts. */
    start: z.number().finite().min(0).max(86400),
    end: z.number().finite().min(0).max(86400),
    fill: z.enum(["surroundings", "reference"]).optional(),
    referenceTime: z.number().finite().min(0).max(86400).optional(),
    strokes: z.array(stroke).max(MAX_MASK_STROKES),
  }).strict().refine(value => value.end > value.start, "End must be after start")
    .refine(value => value.fill !== "reference" || value.referenceTime !== undefined, "Choose a clean source frame for this area")).max(MAX_WATERMARK_MASKS),
}).strict().refine(value => new Set(value.masks.map(mask => mask.id)).size === value.masks.length, "Mask IDs must be unique")
  .refine(value => value.masks.reduce((total, mask) => total + mask.strokes.reduce((sum, item) => sum + item.points.length, 0), 0) <= MAX_MASK_POINTS, "Too many brush points. Clear an unused area first.");
export type WatermarkRemoval = z.infer<typeof watermarkRemovalSchema>;
export type WatermarkMask = WatermarkRemoval["masks"][number];
export type MaskStroke = WatermarkMask["strokes"][number];
export type MaskPoint = MaskStroke["points"][number];
export const DEFAULT_WATERMARK_REMOVAL: WatermarkRemoval = { enabled: false, mode: "fixed", masks: [] };

export function removalMasks(value?: WatermarkRemoval): WatermarkMask[] {
  return !value?.enabled ? [] : value.mode === "fixed" ? value.masks.slice(0, 1) : value.masks;
}
export function activeRemovalMasks(value: WatermarkRemoval, time: number) {
  return removalMasks(value).filter(mask => value.mode === "fixed" || (time >= mask.start && time < mask.end));
}

/** A binary mask shared by the on-video brush and the renderer, including erasures. */
export function rasterizeMask(strokes: MaskStroke[], width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 17_000_000)
    throw new Error("Watermark removal supports source frames up to 16 megapixels.");
  const pixels = new Uint8Array(width * height);
  for (const item of strokes) {
    const points = item.points.map(p => ({ x: p.x * width, y: p.y * height }));
    if (item.kind === "rect") {
      const a = points[0]!, b = points[1]!;
      const left = Math.max(0, Math.floor(Math.min(a.x, b.x))), right = Math.min(width, Math.ceil(Math.max(a.x, b.x)));
      for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y))); y < Math.min(height, Math.ceil(Math.max(a.y, b.y))); y++) pixels.fill(255, y * width + left, y * width + right);
      continue;
    }
    const radius = item.size * Math.min(width, height) / 2, value = item.kind === "erase" ? 0 : 255;
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(0, i - 1)]!, b = points[i]!;
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
      for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius)); y < Math.min(height, Math.ceil(Math.max(a.y, b.y) + radius)); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius)); x < Math.min(width, Math.ceil(Math.max(a.x, b.x) + radius)); x++) {
          const t = length ? Math.max(0, Math.min(1, ((x + .5 - a.x) * dx + (y + .5 - a.y) * dy) / length)) : 0;
          if ((x + .5 - a.x - t * dx) ** 2 + (y + .5 - a.y - t * dy) ** 2 <= radius * radius) pixels[y * width + x] = value;
        }
      }
    }
  }
  return pixels;
}

/** Keep the selected mark fully covered; blend only a narrow surrounding margin. */
export function featherMask(pixels: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return pixels;
  const distance = new Uint16Array(pixels.length).fill(65535);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    distance[i] = pixels[i] ? 0 : Math.min(65535, x ? distance[i - 1]! + 1 : 65535, y ? distance[i - width]! + 1 : 65535);
  }
  const alpha = new Uint8Array(pixels.length);
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    distance[i] = Math.min(distance[i]!, x < width - 1 ? distance[i + 1]! + 1 : 65535, y < height - 1 ? distance[i + width]! + 1 : 65535);
    const t = Math.max(0, 1 - distance[i]! / radius);
    alpha[i] = Math.round(255 * t * t * (3 - 2 * t));
  }
  return alpha;
}

/** A mask follows every occurrence of a source interval, even reordered/repeated cuts. */
export function removalIntervals(mask: WatermarkMask, cuts: { start: number; end: number }[], speed: number) {
  let offset = 0;
  return cuts.flatMap(cut => {
    const start = Math.max(cut.start, mask.start), end = Math.min(cut.end, mask.end);
    const interval = end > start ? [{ start: (offset + start - cut.start) / speed, end: (offset + end - cut.start) / speed }] : [];
    offset += cut.end - cut.start;
    return interval;
  });
}
