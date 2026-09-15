import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";

export interface BrollWindow {
  sourceStart: number;
  duration: number;
  /** Sustained visible motion in the centered output crop, normalized to 0–1. */
  motion: number;
  /** Fraction of the source image retained by a centered crop, not a subject score. */
  cropRetention: number;
  score: number;
}

const SAMPLE_FPS = 8;
const SAMPLE_SIDE = 96;
const MAX_WINDOWS = 5;
const WINDOW_DURATION = 3.6;

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
}

/** Compression noise and one large cut do not establish that a shot is moving. */
function sustainedMotion(frames: Uint8Array, frameSize: number): number {
  const frameCount = Math.floor(frames.length / frameSize);
  if (frameCount < 6) return 0;
  let blackFrames = 0;
  let blackRun = 0;
  let longestBlackRun = 0;
  const differences: number[] = [];
  const active: boolean[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const offset = frame * frameSize;
    let dark = 0;
    let changed = 0;
    let difference = 0;
    for (let pixel = 0; pixel < frameSize; pixel++) {
      const value = frames[offset + pixel]!;
      if (value <= 18) dark++;
      if (frame > 0) {
        const delta = Math.abs(value - frames[offset - frameSize + pixel]!);
        // Small codec fluctuations around static edges are not useful motion.
        if (delta > 8) {
          changed++;
          difference += delta;
        }
      }
    }
    if (dark / frameSize >= 0.97) {
      blackFrames++;
      blackRun++;
      longestBlackRun = Math.max(longestBlackRun, blackRun);
    } else blackRun = 0;
    if (frame > 0) {
      const meanDifference = difference / frameSize / 255;
      differences.push(meanDifference);
      active.push(changed / frameSize >= 0.008 && meanDifference >= 0.001);
    }
  }
  if (blackFrames / frameCount >= 0.2 || longestBlackRun >= 4) return 0;

  const activeCount = active.filter(Boolean).length;
  if (activeCount < Math.max(3, Math.ceil(active.length * 0.35))) return 0;
  // Require motion across the interval; an isolated scene cut or short opening
  // animation followed by a still must not pass on a high average difference.
  const blockCount = Math.min(4, Math.floor(active.length / 3));
  const activeBlocks = new Set<number>();
  active.forEach((moving, index) => {
    if (moving) activeBlocks.add(Math.floor((index * blockCount) / active.length));
  });
  if (activeBlocks.size < Math.min(3, blockCount)) return 0;

  const sorted = [...differences].sort((a, b) => a - b);
  const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.8)));
  const mean = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  return Math.min(1, mean / 0.04) * 0.6 + (activeCount / active.length) * 0.4;
}

/**
 * Inspect at most 18 seconds per asset locally. Every score describes its
 * returned interval after the centered crop used by B-roll rendering.
 * Returning [] means no sampled interval passed; it does not prove that every
 * possible interval in a long source is unsuitable.
 */
export async function inspectBrollWindows(
  asset: { filePath: string; duration: number; width: number; height: number },
  targetAspect: number,
  signal: AbortSignal,
  exactWindow?: { sourceStart: number; duration: number },
): Promise<BrollWindow[]> {
  checkCancelled(signal);
  if (
    !Number.isFinite(asset.duration) || asset.duration < 1.5 ||
    !Number.isFinite(asset.width) || asset.width < 2 ||
    !Number.isFinite(asset.height) || asset.height < 2 ||
    !Number.isFinite(targetAspect) || targetAspect <= 0
  ) return [];

  if (exactWindow && (!Number.isFinite(exactWindow.sourceStart) || exactWindow.sourceStart < 0 ||
      !Number.isFinite(exactWindow.duration) || exactWindow.duration < 1.5 || exactWindow.duration > WINDOW_DURATION ||
      exactWindow.sourceStart + exactWindow.duration > asset.duration + 0.01)) return [];
  const duration = exactWindow?.duration ?? Math.min(WINDOW_DURATION, asset.duration);
  const available = Math.max(0, asset.duration - duration);
  // Very short clips need one inspection, not five nearly identical decodes.
  const count = Math.min(MAX_WINDOWS, Math.floor(available / 0.75) + 1);
  const starts = exactWindow ? [exactWindow.sourceStart] : Array.from({ length: count }, (_, index) =>
    count === 1 ? 0 : Math.round((available * index / (count - 1)) * 1000) / 1000,
  );
  const sourceAspect = asset.width / asset.height;
  const cropRetention = Math.min(sourceAspect / targetAspect, targetAspect / sourceAspect);
  // Crop at native dimensions before reducing resolution so movement outside
  // the final portrait image cannot qualify an otherwise static center.
  const cropWidth = Math.min(asset.width, asset.height * targetAspect);
  const cropHeight = Math.min(asset.height, asset.width / targetAspect);
  if (cropWidth < 2 || cropHeight < 2) return [];
  const sampleWidth = Math.max(2, Math.round(SAMPLE_SIDE * Math.min(1, targetAspect)));
  const sampleHeight = Math.max(2, Math.round(SAMPLE_SIDE * Math.min(1, 1 / targetAspect)));
  const frameSize = sampleWidth * sampleHeight;
  const frameLimit = Math.ceil(duration * SAMPLE_FPS);
  const directory = await mkdtemp(path.join(os.tmpdir(), "broll-motion-"));
  try {
    const windows: BrollWindow[] = [];
    for (const sourceStart of starts) {
      checkCancelled(signal);
      const output = path.join(directory, "frames.gray");
      await runLocal("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-threads", "1", "-ss", String(sourceStart),
        ...MEDIA_INPUT_ARGS, "-i", asset.filePath,
        "-t", String(duration), "-an", "-sn", "-dn",
        "-filter_threads", "1",
        "-vf", [
          `crop=${Math.floor(cropWidth / 2) * 2}:${Math.floor(cropHeight / 2) * 2}`,
          `fps=${SAMPLE_FPS}:start_time=0`,
          `scale=${sampleWidth}:${sampleHeight}:flags=area`,
          "format=gray",
        ].join(","),
        "-frames:v", String(frameLimit), "-threads", "1",
        "-f", "rawvideo", output,
      ], { signal, timeout: 15000 });
      checkCancelled(signal);
      const frames = await readFile(output);
      checkCancelled(signal);
      // A truncated download must not qualify a longer interval than decoded.
      if (Math.floor(frames.length / frameSize) < Math.floor(duration * SAMPLE_FPS) - 1)
        continue;
      const motion = sustainedMotion(frames, frameSize);
      if (motion > 0) windows.push({
        sourceStart, duration, motion, cropRetention,
        score: motion * 0.8 + cropRetention * 0.2,
      });
    }
    return windows.sort((a, b) => b.score - a.score || a.sourceStart - b.sourceStart).slice(0, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
