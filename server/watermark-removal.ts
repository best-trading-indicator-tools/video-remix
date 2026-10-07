import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { rasterizeMask, removalIntervals, removalMasks, type WatermarkRemoval } from "../shared/watermark-removal.js";

export class WatermarkRemovalError extends Error {}

/** Bound FFmpeg's neighbor-search radius before constructing its convolution kernels. */
function validateMask(pixels: Uint8Array, width: number, height: number) {
  const distance = new Uint16Array(pixels.length);
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!pixels[i]) continue;
    count++;
    distance[i] = 1 + Math.min(x ? distance[i - 1]! : 0, y ? distance[i - width]! : 0);
  }
  let maximum = 0;
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (!pixels[i]) continue;
    distance[i] = Math.min(distance[i]!, 1 + Math.min(x < width - 1 ? distance[i + 1]! : 0, y < height - 1 ? distance[i + width]! : 0));
    maximum = Math.max(maximum, distance[i]!);
  }
  if (count > pixels.length * .25 || maximum > 96)
    throw new WatermarkRemovalError("The watermark selection is too large. Brush closely around the mark with a smaller area.");
  return count > 0;
}

export async function watermarkFilters(value: WatermarkRemoval | undefined, width: number, height: number,
  cuts: { start: number; end: number }[], speed: number, workDir: string, temporary: string[], signal: AbortSignal) {
  const filters: string[] = [];
  if (value?.enabled && width * height > 17_000_000) throw new WatermarkRemovalError("Watermark removal supports source frames up to 16 megapixels.");
  for (const mask of removalMasks(value)) {
    signal.throwIfAborted();
    const intervals = value!.mode === "fixed" ? [] : removalIntervals(mask, cuts, speed);
    if (value!.mode === "timed" && !intervals.length) continue;
    const pixels = rasterizeMask(mask.strokes, width, height);
    if (!validateMask(pixels, width, height)) continue;
    const filename = `watermark-${randomUUID()}.pgm`, file = path.join(workDir, filename);
    temporary.push(file);
    await writeFile(file, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]));
    const number = (n: number) => Number(n.toFixed(8));
    const enable = intervals.length ? `:enable='${intervals.map(interval => `gte(t,${number(interval.start)})*lt(t,${number(interval.end)})`).join("+")}'` : "";
    filters.push(`removelogo=filename=${filename}${enable}`);
  }
  return filters;
}
