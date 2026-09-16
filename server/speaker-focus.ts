import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EditSegment, FocalPoint } from "../shared/types.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";
import { paths } from "./config.js";

const parentDirectory = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const projectRoot =
  path.basename(parentDirectory) === "dist-server"
    ? path.dirname(parentDirectory)
    : parentDirectory;
const python = path.join(
  projectRoot,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const script = path.join(projectRoot, "scripts/speaker_focus.py");
const SCHEMA = "yunet-2023mar-focus-v2";
const MAX_FRAMES = 180;
// Normalize anamorphic pixels before detection without making a large
// intermediate frame. Normalized centers still map to the original source.
const displaySar = "if(gt(sar,0),sar,1)";
const sampleScale = `min(1,min(640/(iw*${displaySar}),640/ih))`;
const sampleFilter = `scale=w='max(2,trunc(iw*${displaySar}*${sampleScale}/2)*2)':h='max(2,trunc(ih*${sampleScale}/2)*2)',setsar=1`;
const pointSchema = z.object({
  time: z.number().finite().nonnegative(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
const resultSchema = z
  .object({
    status: z.enum(["tracked", "partial", "no-face", "unavailable"]),
    tracks: z
      .array(
        z.object({
          cutIndex: z.number().int().min(0).max(59),
          start: z.number().finite().nonnegative(),
          end: z.number().finite().positive(),
          keyframes: z.array(pointSchema).min(2).max(120),
          coverage: z.number().min(0).max(1),
        }),
      )
      .max(60),
    sampledFrames: z.number().int().min(0).max(MAX_FRAMES),
    detectedFrames: z.number().int().min(0).max(MAX_FRAMES),
    multipleFaces: z.boolean(),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (result) =>
      result.tracks.reduce((sum, track) => sum + track.keyframes.length, 0) <=
        240 && result.detectedFrames <= result.sampledFrames,
  );

export type SpeakerFocusResult = z.infer<typeof resultSchema>;
export interface SpeakerFocusOptions {
  source: {
    filePath: string;
    duration: number;
    width: number;
    height: number;
    fingerprint?: string;
  };
  cuts: EditSegment[];
  /** Source-normalized center of the user's manually selected subject. */
  seed?: FocalPoint;
  signal: AbortSignal;
  cacheDir?: string;
}

const unavailable = (reason: string): SpeakerFocusResult => ({
  status: "unavailable",
  tracks: [],
  sampledFrames: 0,
  detectedFrames: 0,
  multipleFaces: false,
  reason,
});

/** Checks local dependencies/model integrity only. Never downloads anything. */
export async function speakerFocusAvailable(
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    await Promise.all([access(python), access(script)]);
    const check = await runLocal(python, [script, "--check"], {
      signal,
      timeout: 15_000,
    });
    return JSON.parse(check.stdout).available === true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function validate(options: SpeakerFocusOptions): void {
  const { cuts, source, seed } = options;
  const validPoint = (point: FocalPoint | undefined) =>
    point === undefined ||
    [point.x, point.y].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    );
  if (
    ![source.duration, source.width, source.height].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !cuts.length ||
    cuts.length > 60 ||
    cuts.some(
      (cut) =>
        !Number.isFinite(cut.start) ||
        !Number.isFinite(cut.end) ||
        cut.start < 0 ||
        cut.end <= cut.start ||
        cut.end > 86400 ||
        !validPoint(cut.focalPoint) ||
        cut.end > source.duration + 0.001,
    ) ||
    !validPoint(seed)
  ) {
    throw new Error("Choose up to 60 valid source intervals for face framing.");
  }
}

function sampleTimes(
  cuts: EditSegment[],
): Array<{ cutIndex: number; time: number }> {
  const desired = cuts.map((cut) =>
    Math.max(2, Math.min(118, Math.ceil((cut.end - cut.start) * 2))),
  );
  const counts = desired.map(() => 2);
  let left = MAX_FRAMES - counts.length * 2;
  // Allocate remaining samples to the sparsest interval first.
  while (left > 0) {
    let selected = -1;
    let spacing = 0;
    for (let index = 0; index < cuts.length; index++) {
      const interval = (cuts[index]!.end - cuts[index]!.start) / counts[index]!;
      if (counts[index]! < desired[index]! && interval > spacing) {
        spacing = interval;
        selected = index;
      }
    }
    if (selected < 0) break;
    counts[selected] = counts[selected]! + 1;
    left--;
  }
  return cuts.flatMap((cut, cutIndex) =>
    Array.from({ length: counts[cutIndex] }, (_, index) => ({
      cutIndex,
      // Sample strictly within this selected source interval, including VFR media.
      time:
        cut.start + ((cut.end - cut.start) * (index + 0.5)) / counts[cutIndex]!,
    })),
  );
}

function validResult(
  value: unknown,
  cuts: EditSegment[],
): SpeakerFocusResult | undefined {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  if (
    new Set(result.tracks.map((track) => track.cutIndex)).size !==
      result.tracks.length ||
    result.tracks.some((track) => {
      const cut = cuts[track.cutIndex];
      return (
        !cut ||
        track.start !== cut.start ||
        track.end !== cut.end ||
        track.keyframes[0]!.time !== cut.start ||
        track.keyframes.at(-1)!.time !== cut.end ||
        track.keyframes.some(
          (point, index) =>
            point.time < cut.start ||
            point.time > cut.end ||
            (index > 0 && point.time <= track.keyframes[index - 1]!.time),
        )
      );
    })
  )
    return undefined;
  if (
    (result.status === "tracked" || result.status === "partial") !==
    result.tracks.length > 0
  )
    return undefined;
  return result;
}

/** Analyze only the requested cuts, with bounded CPU, disk use, and wall time. */
export async function analyzeSpeakerFocus(
  options: SpeakerFocusOptions,
): Promise<SpeakerFocusResult> {
  validate(options);
  options.signal.throwIfAborted();
  const { source, seed } = options;
  const cuts = options.cuts.map(({ start, end, focalPoint }) => ({
    start,
    end,
    ...(focalPoint ? { focalPoint: { x: focalPoint.x, y: focalPoint.y } } : {}),
  }));
  const cacheDir =
    options.cacheDir || path.join(paths.analysis, "speaker-focus");
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(135_000),
  ]);
  let work: string | undefined;
  try {
    const filePath = await realpath(source.filePath);
    const info = await stat(filePath);
    if (!info.isFile())
      return unavailable(
        "The source video is no longer available. Keep your manual framing.",
      );
    const identity = createHash("sha256")
      .update(
        JSON.stringify({
          schema: SCHEMA,
          fingerprint: source.fingerprint,
          filePath,
          device: info.dev,
          inode: info.ino,
          size: info.size,
          modified: info.mtimeMs,
          cuts,
          seed,
        }),
      )
      .digest("hex");
    const cacheFile = path.join(cacheDir, `${identity}.json`);
    try {
      const cached = validResult(
        JSON.parse(await readFile(cacheFile, "utf8")),
        cuts,
      );
      if (cached && cached.status !== "unavailable") return cached;
    } catch {
      /* A missing or obsolete cache is safe to recompute. */
    }
    if (!(await speakerFocusAvailable(signal)))
      return unavailable(
        "Local face framing is not installed. Run npm run setup:focus, then try again.",
      );
    await mkdir(cacheDir, { recursive: true });
    work = await mkdtemp(path.join(cacheDir, ".frames-"));
    const frames: Array<{ cutIndex: number; time: number; path: string }> = [];
    for (const [index, sample] of sampleTimes(cuts).entries()) {
      signal.throwIfAborted();
      const framePath = path.join(work, `${index}.jpg`);
      await runLocal(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-threads",
          "1",
          "-ss",
          sample.time.toFixed(6),
          ...MEDIA_INPUT_ARGS,
          "-i",
          filePath,
          "-t",
          (cuts[sample.cutIndex]!.end - sample.time).toFixed(6),
          "-frames:v",
          "1",
          "-an",
          "-sn",
          "-dn",
          "-filter_threads",
          "1",
          "-vf",
          sampleFilter,
          "-q:v",
          "4",
          "-threads",
          "1",
          "-y",
          framePath,
        ],
        { signal, timeout: 12_000 },
      );
      await access(framePath);
      frames.push({ ...sample, path: framePath });
    }
    const manifest = path.join(work, "manifest.json");
    await writeFile(manifest, JSON.stringify({ frames, cuts, seed }));
    const analysis = await runLocal(python, [script, "--manifest", manifest], {
      signal,
      timeout: 40_000,
    });
    signal.throwIfAborted();
    const current = await stat(filePath);
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs
    )
      return unavailable(
        "The source changed during analysis. Keep your manual framing and try again.",
      );
    const result = validResult(JSON.parse(analysis.stdout), cuts);
    if (!result)
      return unavailable(
        "Face framing could not produce a reliable track. Keep your manual framing.",
      );
    result.reason =
      result.status === "no-face"
        ? "No face could be tracked confidently in these intervals. Your manual framing is kept."
        : result.multipleFaces
          ? "Several faces are visible. Follows the predominant face or the face nearest your selected position; it does not identify the active voice."
          : result.status === "partial"
            ? "A face was tracked in part of the selection. Manual framing is kept where no reliable track is available."
            : "Follows the visible face locally. This does not identify the active voice from audio.";
    if (
      cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) > frames.length
    ) {
      result.reason +=
        " Sparse sampling may miss fast movement in long selections.";
    }
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(result));
      await rename(temporary, cacheFile);
    } catch {
      /* A full cache disk should not invalidate a usable track. */
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return result;
  } catch {
    options.signal.throwIfAborted();
    return unavailable(
      signal.aborted
        ? "Face framing took too long. Select a shorter interval or keep your manual framing."
        : "These frames could not be analyzed locally. Keep your manual framing or try a shorter interval.",
    );
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}
