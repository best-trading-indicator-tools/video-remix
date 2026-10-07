import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { rasterizeMask, removalIntervals, removalMasks, type WatermarkRemoval } from "../shared/watermark-removal.js";

export class WatermarkRemovalError extends Error {
  readonly status = 422;
}

/** Measure the search radius; it controls processing resolution, not selection validity. */
function maskRadius(pixels: Uint8Array, width: number, height: number) {
  const distance = new Uint16Array(pixels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!pixels[i]) continue;
    distance[i] = 1 + Math.min(x ? distance[i - 1]! : 0, y ? distance[i - width]! : 0);
  }
  let maximum = 0;
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x;
    if (!pixels[i]) continue;
    distance[i] = Math.min(distance[i]!, 1 + Math.min(x < width - 1 ? distance[i + 1]! : 0, y < height - 1 ? distance[i + width]! : 0));
    maximum = Math.max(maximum, distance[i]!);
  }
  return maximum;
}

function validateMask(pixels: Uint8Array) {
  let count = 0;
  for (const pixel of pixels) if (pixel) count++;
  if (count > pixels.length * .25)
    throw new WatermarkRemovalError("The watermark selection covers more than 25% of the picture. Reduce the marked area or turn off watermark removal.");
  return count > 0;
}

/** Reject invalid selections before Auto analysis or review spends time on the job. */
export function validateWatermarkRemoval(value: WatermarkRemoval | undefined, width: number, height: number) {
  if (!value?.enabled) return;
  if (width * height > 17_000_000) throw new WatermarkRemovalError("Watermark removal supports source frames up to 16 megapixels.");
  for (const mask of removalMasks(value)) validateMask(rasterizeMask(mask.strokes, width, height));
}

/** Conservatively downsample the mask, including a pixel of resampling support. */
function reducedMask(pixels: Uint8Array, width: number, height: number, smallWidth: number, smallHeight: number) {
  const reduced = new Uint8Array(smallWidth * smallHeight);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[y * width + x]) reduced[Math.floor(y * smallHeight / height) * smallWidth + Math.floor(x * smallWidth / width)] = 255;
  }
  const expanded = new Uint8Array(reduced.length);
  for (let y = 0; y < smallHeight; y++) for (let x = 0; x < smallWidth; x++) {
    if (!reduced[y * smallWidth + x]) continue;
    for (let dy = Math.max(0, y - 1); dy <= Math.min(smallHeight - 1, y + 1); dy++)
      expanded.fill(255, dy * smallWidth + Math.max(0, x - 1), dy * smallWidth + Math.min(smallWidth, x + 2));
  }
  return expanded;
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
    if (!validateMask(pixels)) continue;
    const writeMask = async (data: Uint8Array, w: number, h: number) => {
      const filename = `watermark-${randomUUID()}.pgm`, file = path.join(workDir, filename);
      temporary.push(file);
      await writeFile(file, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), data]));
      return filename;
    };
    const number = (n: number) => Number(n.toFixed(8));
    const enable = intervals.length ? `:enable='${intervals.map(interval => `gte(t,${number(interval.start)})*lt(t,${number(interval.end)})`).join("+")}'` : "";
    const radius = maskRadius(pixels, width, height);
    if (radius <= 24) {
      filters.push(`removelogo=filename=${await writeMask(pixels, width, height)}${enable}`);
      continue;
    }
    // Thick marks at HD/4K need bounded reconstruction kernels, not rejection or
    // a lower-resolution export. Only the cleaned patch is scaled; the original
    // full-resolution mask composites it onto untouched source pixels.
    let scale = 20 / radius, smallWidth: number, smallHeight: number, small: Uint8Array;
    do {
      signal.throwIfAborted();
      smallWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
      smallHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
      small = reducedMask(pixels, width, height, smallWidth, smallHeight);
      scale *= .75;
    } while (maskRadius(small, smallWidth, smallHeight) > 24);
    const filename = await writeMask(small, smallWidth, smallHeight);
    const alpha = await writeMask(pixels, width, height);
    const label = `watermark${filters.length}`;
    filters.push(`split[${label}original][${label}work];` +
      `[${label}work]scale=${smallWidth}:${smallHeight}:flags=area,setsar=1,removelogo=filename=${filename}${enable},` +
      `scale=${width}:${height}:flags=bilinear,setsar=1[${label}clean];` +
      `movie=filename=${alpha},format=gray[${label}mask];` +
      `[${label}clean][${label}mask]alphamerge[${label}patch];` +
      `[${label}original][${label}patch]overlay=0:0:format=auto${enable}`);
  }
  return filters;
}
