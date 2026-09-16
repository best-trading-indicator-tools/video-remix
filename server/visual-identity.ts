import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VisualIdentity } from "../shared/visual-identity.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";

function hashFrame(pixels: Uint8Array): { hash: string; mask: string } {
  let hash = 0n, mask = 0n;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const delta = pixels[y * 17 + x + 1]! - pixels[y * 17 + x]!;
    hash = (hash << 1n) | BigInt(delta > 0 ? 1 : 0);
    mask = (mask << 1n) | BigInt(Math.abs(delta) >= 4 ? 1 : 0);
  }
  return { hash: hash.toString(16).padStart(64, "0"), mask: mask.toString(16).padStart(64, "0") };
}

/** Six small, independently sought frames: bounded memory even for very large files. */
export async function visualIdentity(file: string, duration: number, signal?: AbortSignal): Promise<VisualIdentity> {
  const result: VisualIdentity = { version: 1, duration, frames: [] };
  if (!Number.isFinite(duration) || duration < 0.5) return result;
  const directory = await mkdtemp(path.join(tmpdir(), "remix-picture-id-"));
  const started = Date.now();
  try {
    for (const fraction of [0.08, 0.24, 0.4, 0.56, 0.72, 0.88]) {
      signal?.throwIfAborted();
      const remaining = 15000 - (Date.now() - started);
      if (remaining <= 0) break;
      const at = duration * fraction;
      const output = path.join(directory, "frame.gray");
      await runLocal("ffmpeg", ["-v", "error", "-y", "-threads", "1", "-ss", String(at), ...MEDIA_INPUT_ARGS, "-i", file,
        "-filter_complex_threads", "1", "-filter_complex",
        "[0:v]split=2[a][b];[a]scale=17:16:flags=area,format=gray[a1];[b]crop='min(iw,ih*9/16)':ih,scale=17:16:flags=area,format=gray[b1];[a1][b1]vstack=inputs=2[v]",
        "-map", "[v]", "-frames:v", "1", "-f", "rawvideo", output], { signal, timeout: remaining });
      const bytes = await readFile(output);
      if (bytes.length !== 544) continue;
      result.frames.push({ at, full: hashFrame(bytes.subarray(0, 272)), portrait: hashFrame(bytes.subarray(272)) });
    }
  } catch { signal?.throwIfAborted(); /* Missing/unreadable media means unknown, never a match. */ }
  finally { await rm(directory, { recursive: true, force: true }); }
  return result;
}

function bitCount(value: bigint): number {
  let count = 0;
  while (value) { value &= value - 1n; count++; }
  return count;
}
function distance(a: { hash: string; mask: string }, b: { hash: string; mask: string }): number {
  if (![a.hash, a.mask, b.hash, b.mask].every(value => /^[0-9a-f]{64}$/u.test(value))) return 1;
  const am = BigInt(`0x${a.mask}`), bm = BigInt(`0x${b.mask}`), common = am & bm;
  const count = bitCount(common);
  if (count < 24 || count / Math.max(bitCount(am), bitCount(bm), 1) < 0.6) return 1;
  return bitCount((BigInt(`0x${a.hash}`) ^ BigInt(`0x${b.hash}`)) & common) / count;
}
function hasChangingPicture(frames: VisualIdentity["frames"], kind: "full" | "portrait"): boolean {
  const distinct: VisualIdentity["frames"] = [];
  for (const frame of frames) if (!distinct.some(prior => distance(prior[kind], frame[kind]) < 0.06)) distinct.push(frame);
  return distinct.length >= 3;
}

/** Conservative same-duration recognition. No mapping of fuzzy matches onto source timestamps. */
export function similarPicture(a?: VisualIdentity, b?: VisualIdentity): { matchedFrames: number; sampledFrames: number } | undefined {
  if (!a || !b || a.version !== 1 || b.version !== 1 || a.frames.length !== 6 || b.frames.length !== 6) return;
  if (Math.abs(a.duration - b.duration) > Math.max(0.4, Math.min(a.duration, b.duration) * 0.01)) return;
  for (const left of ["full", "portrait"] as const) for (const right of ["full", "portrait"] as const) {
    if (!hasChangingPicture(a.frames, left) || !hasChangingPicture(b.frames, right)) continue;
    const matches = a.frames.filter((frame, index) => distance(frame[left], b.frames[index]![right]) <= 0.1).length;
    if (matches >= 5) return { matchedFrames: matches, sampledFrames: 6 };
  }
}
