import { spawn } from "node:child_process";
import { MAX_FOCUS_POINTS_TOTAL, validFocusTrack } from "../shared/focus.js";
import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captionStyleSchema, captionAssStyle } from "../shared/caption-style.js";
import { captionsAss, parseCanonicalSrt } from "./caption-ass.js";
import { blackBandsSchema, blackBandGeometry, bandTextLayout } from "../shared/black-bands.js";
import { AUDIO_LOOK_KEYS, AUDIO_RANGES, MAX_AUDIO_FADE } from "../shared/audio.js";
import { audioFadeFilters, audioModifierFilters, audioNormalizationFilters } from "./audio-filters.js";
import type { CaptionStyle, RemixSettings, TranscriptWord } from "../shared/types.js";
import { MAX_BROLL_COUNT } from "../shared/types.js";
import type { SupportingVisual } from "./visuals.js";
import { wrapEditorialText as wrapHook } from "../shared/framing.js";
import { footageTimeline, ownFootageSchema, resolveFootagePlacement } from "../shared/own-footage.js";
import { composeFootage, type ResolvedFootage } from "./footage-composition.js";
import { prepareConcatSource } from "./concat-source.js";
import { assertCleanExportMetadata, CLEAN_EXPORT_METADATA_ARGS } from "./export-metadata.js";

export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}
interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  onStdout?: (chunk: string) => void;
}
const FORMATS =
  "mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf,wav,mp3,flac,aac,aiff,nut";
const SAFE_INPUT = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  FORMATS,
];
const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const decimal = (value: number) => Number(value.toFixed(8)).toString();
const abortError = () =>
  Object.assign(new Error("Render cancelled"), { name: "AbortError" });

/** No shell is involved. Limit diagnostics and kill children even if graceful cancellation stalls. */
function run(
  binary: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };
    const timeout = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeout)
      : undefined;
    timeout?.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", terminate);
    };
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = (stdout + text).slice(-4_000_000);
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (options.signal?.aborted) reject(abortError());
      else if (timedOut)
        reject(new Error(`${binary} exceeded the processing time limit`));
      else if (code !== 0)
        reject(
          new Error(
            `${binary} failed: ${stderr.trim().slice(-4_000) || (signal ? `signal ${signal}` : `exit ${code}`)}`,
          ),
        );
      else resolve(stdout);
    });
  });
}

async function localFile(filePath: string): Promise<string> {
  // Force an ordinary filesystem path; URL inputs and pseudo-protocols never reach FFmpeg.
  const absolute = await realpath(path.resolve(filePath));
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0)
    throw new Error("Media must be a non-empty local file");
  return absolute;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}
interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string; tags?: Record<string, string> };
  chapters?: unknown[];
}

async function probe(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const input = await localFile(filePath);
  const output = await run(
    "ffprobe",
    [
      "-v",
      "error",
      ...SAFE_INPUT,
      "-show_streams",
      "-show_format",
      "-show_chapters",
      "-of",
      "json",
      input,
    ],
    { timeout: 30_000, signal },
  );
  try {
    return JSON.parse(output) as ProbeResult;
  } catch {
    throw new Error("Could not read media information");
  }
}

function ratio(value: string | undefined, separator = "/"): number {
  if (!value) return 0;
  const parts = value.split(separator).map(Number);
  return parts.length === 2 &&
    Number.isFinite(parts[0]) &&
    Number.isFinite(parts[1]) &&
    parts[1]! > 0
    ? parts[0]! / parts[1]!
    : 0;
}

export async function probeMedia(filePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  signal?.throwIfAborted();
  const info = await probe(filePath, signal);
  const video = info.streams?.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  if (!video?.width || !video.height)
    throw new Error("This file does not contain a playable video stream");
  const duration = Number(video.duration ?? info.format?.duration);
  const fps = ratio(video.avg_frame_rate) || ratio(video.r_frame_rate);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 1000
  ) {
    throw new Error("Video duration or frame rate could not be determined");
  }
  const pixelAspect = ratio(video.sample_aspect_ratio, ":") || 1;
  let width = Math.round(video.width * pixelAspect);
  let height = video.height;
  const rotation =
    video.side_data_list?.find((side) => typeof side.rotation === "number")
      ?.rotation ?? Number(video.tags?.rotate ?? 0);
  if (Math.abs(Math.round(rotation / 90)) % 2 === 1)
    [width, height] = [height, width];
  if (width < 2 || height < 2 || width > 16384 || height > 16384)
    throw new Error("Unsupported video dimensions");
  return {
    duration,
    width,
    height,
    fps,
    hasAudio: !!info.streams?.some((stream) => stream.codec_type === "audio"),
  };
}

export async function probeAudio(filePath: string): Promise<number> {
  const info = await probe(filePath);
  const audio = info.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(audio?.duration ?? info.format?.duration);
  if (!audio || !Number.isFinite(duration) || duration <= 0)
    throw new Error("This file does not contain playable audio");
  return duration;
}

export async function checkBinaries(): Promise<{
  ffmpeg: boolean;
  ffprobe: boolean;
}> {
  const results = await Promise.allSettled(
    ["ffmpeg", "ffprobe"].map((binary) =>
      run(binary, ["-version"], { timeout: 5_000 }),
    ),
  );
  return {
    ffmpeg: results[0]!.status === "fulfilled",
    ffprobe: results[1]!.status === "fulfilled",
  };
}

export async function createThumbnail(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal,
  seekSeconds = 0,
): Promise<void> {
  if (!Number.isFinite(seekSeconds) || seekSeconds < 0) throw new Error("Invalid thumbnail time");
  const input = await localFile(inputPath);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "2",
      ...SAFE_INPUT,
      ...(seekSeconds ? ["-ss", String(seekSeconds)] : []),
      "-i",
      input,
      "-map",
      "0:V:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      "scale=480:480:force_original_aspect_ratio=decrease,setsar=1",
      "-filter_threads",
      "1",
      "-threads",
      "2",
      "-q:v",
      "3",
      "-update",
      "1",
      path.resolve(outputPath),
    ],
    { timeout: 30_000, signal },
  );
}

function validateSettings(settings: RemixSettings): void {
  const ranges: [keyof RemixSettings, number, number][] = [
    ["speed", 0.5, 2],
    ["volume", 0, 3],
    ["zoom", 1, 2],
    ["saturation", 0, 3],
    ["brightness", -1, 1],
    ["contrast", 0, 2],
    ["hue", -180, 180],
    ["gamma", 0.1, 3],
    ["temperature", -1, 1],
    ["noise", 0, 1],
    ["sharpness", 0, 2],
    ["blend", 0, 1],
    ["frameBlend", 0, 0.5],
    ["timeShift", -5, 5],
    ["trimStart", 0, 86_400],
    ["hookDuration", 0, 60],
  ];
  for (const [key, low, high] of ranges) {
    const value = settings[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < low ||
      value > high
    )
      throw new Error(`Invalid ${key} setting`);
  }
  if (
    !settings.segments &&
    settings.trimEnd !== null &&
    (!Number.isFinite(settings.trimEnd) ||
      settings.trimEnd <= settings.trimStart)
  )
    throw new Error("Trim end must be after trim start");
  if (
    !["original", "9:16", "1:1", "4:5", "16:9"].includes(settings.aspect) ||
    !["crop", "contain", "blur"].includes(settings.fit) ||
    !["source", "720", "1080"].includes(settings.resolution) ||
    !["source", "24", "30", "60"].includes(settings.fps)
  )
    throw new Error("Invalid export format");
  if (
    typeof settings.hookText !== "string" ||
    settings.hookText.length > 200 ||
    settings.hookText.includes("\0")
  )
    throw new Error("Hook text must be at most 200 characters");
  if (
    typeof settings.device !== "string" ||
    settings.device.length > 80 ||
    settings.device.includes("\0")
  )
    throw new Error("Invalid device metadata");
  if (
    settings.segments !== undefined &&
    (!Array.isArray(settings.segments) ||
      settings.segments.length === 0 ||
      settings.segments.length > 60 ||
      settings.segments.some(
        (segment) =>
          !Number.isFinite(segment.start) ||
          !Number.isFinite(segment.end) ||
          segment.start < 0 ||
          segment.end - segment.start < 0.04,
      ))
  )
    throw new Error("Choose 1–60 valid source clips of at least 0.04 seconds");
  if (
    settings.callouts !== undefined &&
    (!Array.isArray(settings.callouts) ||
      settings.callouts.length > 60 ||
      settings.callouts.some(
        (callout) =>
          typeof callout.text !== "string" ||
          callout.text.length > 200 ||
          callout.text.includes("\0") ||
          !Number.isFinite(callout.start) ||
          !Number.isFinite(callout.end) ||
          callout.start < 0 ||
          callout.end <= callout.start,
      ))
  )
    throw new Error("Callouts need valid text and start/end times");
  // Audio modifiers are absent on edits saved before sound looks, and neutral
  // when absent; a present value still has to sit inside its slider range.
  for (const key of AUDIO_LOOK_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    const [low, high] = AUDIO_RANGES[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high)
      throw new Error(`Invalid ${key} setting`);
  }
  for (const key of ["fadeIn", "fadeOut"] as const) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_AUDIO_FADE)
      throw new Error(`Invalid ${key} setting`);
  }
  for (const key of ["normalizeAudio", "autoMotion", "qualityCleanup", "smoothCuts"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean")
      throw new Error(`Invalid ${key} setting`);
  }
  if (settings.layout !== undefined && !["single", "split", "presentation"].includes(settings.layout)) throw new Error("Choose a supported video layout");
  if (!validFocalPoint(settings.secondaryFocalPoint)) throw new Error("Choose a valid second subject position");
  if (!validFocalPoint(settings.focalPoint) || settings.segments?.some(segment => !validFocalPoint(segment.focalPoint)))
    throw new Error("Focal points must contain x and y coordinates between 0 and 1");
  if (settings.segments?.some(segment => segment.focusTrack !== undefined && !validFocusTrack(segment.focusTrack, segment.start, segment.end)) ||
    (settings.segments?.reduce((sum, segment) => sum + (segment.focusTrack?.length ?? 0), 0) ?? 0) > MAX_FOCUS_POINTS_TOTAL)
    throw new Error("Focus tracks need bounded, ordered source timestamps and coordinates between 0 and 1");
  const style = settings.captionStyle;
  if (settings.blackBands !== undefined && !blackBandsSchema.safeParse(settings.blackBands).success)
    throw new Error("Black bands need valid sizes, fit and printable text of at most 200 characters per band");
  if (style !== undefined && !captionStyleSchema.safeParse(style).success)
    throw new Error("Caption style needs supported fonts, hex colors and values within their allowed ranges");
}

function validFocalPoint(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const point = value as { x?: unknown; y?: unknown };
  return [point.x, point.y].every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1);
}

/** Crop coordinates use the final edited clock, including reordered/repeated cuts. */
function focalExpression(settings: RemixSettings, axis: "x" | "y"): string {
  const fallback = settings.focalPoint?.[axis] ?? 0.5;
  if (!settings.segments?.length) return decimal(fallback);
  let offset = 0;
  const choices = settings.segments.map(segment => {
    const track = segment.focusTrack;
    let expression = decimal(track?.[0]?.[axis] ?? segment.focalPoint?.[axis] ?? fallback);
    // A sum of clamped ramps interpolates each observed movement and holds its
    // endpoints, without nesting an if() for every point in a long trajectory.
    for (let index = 1; index < (track?.length ?? 0); index++) {
      const previous = track![index - 1], next = track![index];
      const delta = next[axis] - previous[axis];
      if (Math.abs(delta) < 1e-8) continue;
      const start = offset + (previous.time - segment.start) / settings.speed;
      const span = Math.max(1e-8, (next.time - previous.time) / settings.speed);
      expression += `+(${decimal(delta)})*clip((t-(${decimal(start)}))/${decimal(span)},0,1)`;
    }
    offset += (segment.end - segment.start) / settings.speed;
    return { end: offset, expression };
  });
  let expression = choices.at(-1)!.expression;
  for (let index = choices.length - 2; index >= 0; index--) {
    const choice = choices[index]!;
    expression = `if(lt(t,${decimal(choice.end)}),${choice.expression},${expression})`;
  }
  return expression;
}

function focalCrop(cropWidth: string, cropHeight: string, x: string, y: string): string {
  return `crop=w='${cropWidth}':h='${cropHeight}':x='max(0,min(iw-ow,iw*(${x})-ow/2))':y='max(0,min(ih-oh,ih*(${y})-oh/2))'`;
}

export function geometry(
  source: MediaInfo,
  settings: RemixSettings,
): { width: number; height: number } {
  let width = source.width;
  let height = source.height;
  const target =
    settings.aspect === "original"
      ? width / height
      : ratio(settings.aspect, ":");
  if (settings.resolution !== "source") {
    const edge = Number(settings.resolution);
    // Set the requested edge directly. Scaling an intermediate crop can land
    // just below720/1080 through floating-point error before even rounding.
    return target >= 1 ? { width: even(edge * target), height: edge }
      : { width: edge, height: even(edge / target) };
  }
  if (settings.blackBands?.enabled || settings.fit === "contain" || settings.fit === "blur") {
    if (width / height > target) height = width / target;
    else width = height * target;
  } else {
    if (width / height > target) width = height * target;
    else height = width / target;
  }
  return { width: even(width), height: even(height) };
}


async function fontOption(workDir: string, temporary: string[]): Promise<string> {
  for (const font of [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ]) {
    try {
      await access(font);
      return `fontfile='${font}'`;
    } catch {
      /* Use the next installed font. */
    }
  }
  // Windows builds need not include fontconfig. Use a bundled font via a safe,
  // relative path rather than passing a drive letter through the filter parser.
  return `fontfile=${await prepareCaptionFonts(workDir, temporary)}/Poppins-Bold.ttf`;
}

async function prepareCaptionFonts(workDir: string, temporary: string[]) {
  const name = `caption-fonts-${randomUUID()}`;
  let directory: string | undefined;
  for (const url of [new URL("../public/caption-fonts", import.meta.url), new URL("../../dist/caption-fonts", import.meta.url)]) {
    try { await access(new URL(`${url.href}/Poppins-Regular.ttf`)); directory = fileURLToPath(url); break; } catch { /* Try production assets. */ }
  }
  if (!directory) throw new Error("Bundled caption fonts are missing. Restore public/caption-fonts or run npm run build.");
  const destination = path.join(workDir, name);
  temporary.push(destination);
  // The bundled fonts total about 1 MB. A private copy avoids symlink privileges
  // and also works when the project and workspace are on different drives.
  await cp(directory, destination, { recursive: true });
  return name;
}

async function canonicalSubtitles(filePath: string, uppercase = false): Promise<string> {
  const local = await localFile(filePath);
  if ((await stat(local)).size > 2 * 1024 * 1024)
    throw new Error("Subtitles must be smaller than 2 MB");
  const text = (await readFile(local, "utf8"))
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text || text.includes("\0"))
    throw new Error("Invalid SRT subtitle file");
  const blocks = text.split(/\n[ \t]*\n+/);
  const timing =
    /^(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3})[ \t]*-->[ \t]*(\d{2,3}):([0-5]\d):([0-5]\d)[,.](\d{3})(?:[ \t]+[^\n]*)?$/;
  const canonical: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0]!.trim())) lines.shift();
    const match = timing.exec((lines.shift() ?? "").trim());
    if (!match || !lines.length)
      throw new Error(
        "Every SRT cue must contain a timestamp and caption text",
      );
    const start =
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / 1000;
    const end =
      Number(match[5]) * 3600 +
      Number(match[6]) * 60 +
      Number(match[7]) +
      Number(match[8]) / 1000;
    if (end <= start) throw new Error("Subtitle end must be after its start");
    const beginStamp = `${match[1]}:${match[2]}:${match[3]},${match[4]}`;
    const endStamp = `${match[5]}:${match[6]}:${match[7]},${match[8]}`;
    // The chosen caption style applies to every cue, including imported SRTs.
    // Remove embedded styling before case conversion; timings and source text stay saved unchanged.
    const plain = lines.join("\n").replace(/<\/?(?:b|i|u|s|font)(?:\s[^>]*)?>/giu, "")
      .replace(/\{\\[^}]*\}/gu, "");
    canonical.push(`${canonical.length + 1}\n${beginStamp} --> ${endStamp}\n${uppercase ? plain.toUpperCase() : plain}`);
  }
  // A canonical numeric cue header ensures the subtitle filter's independent
  // demuxer cannot interpret an uploaded file as a playlist or another format.
  return `${canonical.join("\n\n")}\n`;
}

async function subtitleFilter(subtitlePath: string, style: CaptionStyle | undefined, workDir: string, temporary: string[], words?: TranscriptWord[]) {
  // Word highlighting needs inline color changes, which SRT cannot carry.
  const highlight = style?.wordHighlight === true;
  const filename = `captions-${randomUUID()}.${highlight ? "ass" : "srt"}`;
  const filePath = path.join(workDir, filename);
  temporary.push(filePath);
  const canonical = await canonicalSubtitles(subtitlePath, style?.uppercase);
  await writeFile(filePath, highlight ? captionsAss(parseCanonicalSrt(canonical), style, words) : canonical, "utf8");
  const fontsName = await prepareCaptionFonts(workDir, temporary);
  // The SRT decoder uses a 384 × 288 script canvas at every output resolution.
  return `subtitles=filename=${filename}:fontsdir=${fontsName}:charenc=UTF-8:force_style='${captionAssStyle(style)}'`;
}

/** Caption an already composed MP4. Copy its soundtrack without changing audio or timing. */
export async function burnOutputCaptions(options: { input: string; output: string; subtitlePath: string; style?: CaptionStyle; words?: TranscriptWord[]; workDir: string; signal: AbortSignal }) {
  options.signal.throwIfAborted();
  const input = await localFile(options.input), workDir = path.resolve(options.workDir);
  const output = path.resolve(options.output);
  if (input === output) throw new Error("Output must be different from source");
  await mkdir(workDir, { recursive: true });
  const temporary: string[] = [];
  try {
    const filter = await subtitleFilter(options.subtitlePath, options.style, workDir, temporary, options.words);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", ...SAFE_INPUT,
      "-i", input, "-map", "0:V:0", "-map", "0:a:0?", "-vf", filter, "-filter_threads", "1", "-filter_complex_threads", "1",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2",
      "-c:a", "copy", ...CLEAN_EXPORT_METADATA_ARGS, output],
      { cwd: workDir, signal: options.signal });
    assertCleanExportMetadata(await probe(output, options.signal));
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally { await Promise.all(temporary.map(file => rm(file, { recursive: true, force: true }).catch(() => undefined))); }
}

export interface RenderOptions {
  maximumOutputDuration?: number;
  ownFootage?: ResolvedFootage[];
  input: string;
  output: string;
  settings: RemixSettings;
  source: MediaInfo;
  audioPath?: string;
  subtitlePath?: string;
  /** Recognized speech on the caption clock, for exact word highlighting. */
  captionWords?: TranscriptWord[];
  supportingVisuals?: SupportingVisual[];
  workDir: string;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
  /** Preserve full-edit camera movement when rendering only an opening preview. */
  motionDuration?: number;
}

/** SRT timings and replacement audio refer to the final output timeline. */
export async function renderVideo(options: RenderOptions): Promise<void> {
  const { source, signal } = options;
  // Frame the content independently, then add clean black bands after effects,
  // cutaways and inserted footage. The original finish remains saved when disabled.
  const s = options.settings.blackBands?.enabled
    ? { ...options.settings, fit: options.settings.blackBands.fit, layout: "single" as const }
    : options.settings;
  validateSettings(s);
  if (options.motionDuration !== undefined && (!Number.isFinite(options.motionDuration) || options.motionDuration <= 0))
    throw new Error("Camera motion duration must be a positive finite number");
  if (signal.aborted) throw abortError();
  const input = await localFile(options.input);
  const output = path.resolve(options.output);
  if (input === output) throw new Error("Output must be different from source");
  const workDir = path.resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  const sourceEnd = Math.min(s.trimEnd ?? source.duration, source.duration);
  const segments = s.segments;
  if (segments?.some((segment) => segment.end > source.duration + 0.001))
    throw new Error("Every source clip must be within the video duration");
  const clipLength = segments
    ? segments.reduce((sum, segment) => sum + segment.end - segment.start, 0)
    : sourceEnd - s.trimStart;
  if (!Number.isFinite(clipLength) || clipLength <= 0.04)
    throw new Error("Select at least 0.04 seconds inside the source video");
  // Shift the whole trim window, maintaining its duration and clamping to the source.
  const start = segments
    ? 0
    : clamp(
        s.trimStart + s.timeShift,
        0,
        Math.max(0, source.duration - clipLength),
      );
  const duration = clipLength / s.speed;
  const fps = s.fps === "source" ? source.fps : Number(s.fps);
  const footage = ownFootageSchema.parse(s.ownFootage ?? []).map(placement => {
    const clip = options.ownFootage?.find(item => item.placement.id === placement.id && item.placement.assetId === placement.assetId);
    if (!clip) throw new Error("Your uploaded footage is unavailable. Choose the clip again.");
    const resolved = resolveFootagePlacement(placement, clip.duration);
    if (resolved.end > clip.duration + 0.001) throw new Error("Your footage selection extends beyond the uploaded clip.");
    return { ...clip, placement: resolved };
  });
  const placements = footage.map(clip => clip.placement);
  const footageTimes = footageTimeline(placements, duration, fps);
  let exportDuration = footageTimes.duration;
  const canvas = geometry(source, s);
  const { width, height, top, bottom } = blackBandGeometry(canvas.width, canvas.height, s.blackBands);
  if (canvas.width > 16384 || canvas.height > 16384)
    throw new Error("This aspect ratio exceeds the output size limit. Choose Source resolution or a standard video format.");
  const covers: SupportingVisual[] = footageTimes.covers.map(item => {
    const clip = footage.find(clip => clip.placement.id === item.id)!;
    return { path: clip.path, label: clip.name, kind: "broll", start: item.at, end: item.at + item.length, sourceStart: item.start, fit: item.fit };
  });
  // The user's explicit cutaway has priority over automatically chosen footage.
  const supportingVisuals = [...(options.supportingVisuals ?? []).filter(shot => covers.every(cover => shot.end <= cover.start || shot.start >= cover.end)), ...covers];
  if (
    supportingVisuals.length > MAX_BROLL_COUNT + covers.length ||
    supportingVisuals.some(
      (visual) =>
        !Number.isFinite(visual.start) ||
        !Number.isFinite(visual.end) ||
        !Number.isFinite(visual.sourceStart ?? 0) ||
        visual.start < 0 ||
        visual.end - visual.start < 0.04 ||
        visual.end > duration + 0.001 ||
        (visual.sourceStart ?? 0) < 0 ||
        !validFocalPoint(visual.focalPoint),
    )
  )
    throw new Error(
      `Supporting visuals need valid times within the edited video (maximum ${MAX_BROLL_COUNT})`,
    );
  const temporary: string[] = [];
  let textFont: string | undefined;
  const drawTextFont = async () => textFont ??= await fontOption(workDir, temporary);
  try {
    // The concat demuxer seeks each requested interval in order. Its frame
    // metadata lets select/aselect discard keyframe preroll without another
    // encoding pass or dozens of simultaneously buffered decoder branches.
    let editList: string | undefined;
    let concatSafe = "1";
    if (segments) {
      const sourceName = `edit-source-${randomUUID()}.media`;
      const sourceLink = path.join(workDir, sourceName);
      editList = path.join(workDir, `edit-${randomUUID()}.ffconcat`);
      temporary.push(editList);
      const concatSource = await prepareConcatSource(input, sourceLink, sourceName);
      if (concatSource.linked) temporary.push(sourceLink);
      concatSafe = concatSource.safe;
      await writeFile(
        editList,
        `ffconcat version 1.0\n${segments.map((segment) => `file ${concatSource.file}\ninpoint ${decimal(segment.start)}\noutpoint ${decimal(segment.end)}\nduration ${decimal(segment.end - segment.start)}`).join("\n")}\n`,
        "utf8",
      );
    }
    const filters = [
      ...(segments ? ["select=concatdec_select"] : []),
      `trim=duration=${decimal(clipLength)}`,
      `setpts=(PTS-STARTPTS)/${s.speed}`,
      // Work in display pixels so anamorphic and autorotated inputs export correctly.
      `scale=${even(source.width)}:${even(source.height)}:flags=bicubic`,
      "setsar=1",
      // Clean the selected source pixels before scaling; no external service.
      ...(s.qualityCleanup ? ["hqdn3d=2:2:4:4", "unsharp=5:5:0.15:5:5:0"] : []),
    ];
    const focalX = focalExpression(s, "x");
    const focalY = focalExpression(s, "y");
    if (s.fit === "crop" && (!s.layout || s.layout === "single")) {
      const aspect = decimal(width / height);
      filters.push(focalCrop(
        `max(2,trunc(min(iw,ih*${aspect})/${s.zoom}/2)*2)`,
        `max(2,trunc(min(ih,iw/${aspect})/${s.zoom}/2)*2)`,
        focalX, focalY,
      ));
    } else if (s.zoom !== 1 && (!s.layout || s.layout === "single")) filters.push(focalCrop(
      `max(2,trunc(iw/${s.zoom}/2)*2)`, `max(2,trunc(ih/${s.zoom}/2)*2)`, focalX, focalY,
    ));
    // Points describe subjects in the original source. Mirroring after the
    // crop keeps that same subject instead of selecting its opposite edge.
    if (s.mirror && (!s.layout || s.layout === "single")) filters.push("hflip");
    const sourceEffectsIndex = filters.length;
    const motion = `zoompan=z='1+0.04*min(on/${decimal(Math.max(1, (options.motionDuration ?? duration) * fps - 1))},1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${decimal(fps)}`;
    if (s.layout === "split" || s.layout === "presentation") {
      const topHeight = Math.max(2, Math.floor(height * (s.layout === "presentation" ? 0.6 : 0.5) / 2) * 2);
      const bottomHeight = height - topHeight;
      const panel = (panelHeight: number, x: string, y: string) => {
        const ratio = decimal(width / panelHeight);
        return `${focalCrop(`max(2,trunc(min(iw,ih*${ratio})/${s.zoom}/2)*2)`, `max(2,trunc(min(ih,iw/${ratio})/${s.zoom}/2)*2)`, x, y)},scale=${width}:${panelHeight}:flags=lanczos`;
      };
      const top = s.layout === "presentation"
        ? `scale=${width}:${topHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${topHeight}:(ow-iw)/2:(oh-ih)/2:color=black`
        : panel(topHeight, focalX, focalY);
      const bottom = s.layout === "presentation" ? panel(bottomHeight, focalX, focalY)
        : panel(bottomHeight, decimal(s.secondaryFocalPoint?.x ?? 0.75), decimal(s.secondaryFocalPoint?.y ?? 0.5));
      filters.push(`split=2[layouttop][layoutbottom];[layouttop]${top},setsar=1[layouta];[layoutbottom]${bottom},setsar=1[layoutb];[layouta][layoutb]vstack=inputs=2:shortest=1`);
    } else if (s.fit === "blur")
      filters.push(
        `fps=${decimal(fps)},split=2[blurback][blurfront];[blurback]scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height},gblur=sigma=${decimal(Math.max(8, Math.min(40, Math.min(width, height) * 0.045)))}:steps=2,eq=brightness=-0.12${s.autoMotion ? `,${motion}` : ""}[blurfill];[blurfront]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2[blurpicture];[blurfill][blurpicture]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1`,
      );
    else if (s.fit === "contain")
      filters.push(
        `scale=${width}:${height}:flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      );
    else
      filters.push(
        `scale=${width}:${height}:flags=lanczos`,
      );
    if (s.mirror && s.layout && s.layout !== "single") filters.push("hflip");
    filters.push("setsar=1", `fps=${decimal(fps)}`, "format=yuv420p");
    if (s.autoMotion && s.fit !== "blur") filters.push(motion);
    const colorEffectsIndex = filters.length;
    if (
      s.brightness !== 0 ||
      s.contrast !== 1 ||
      s.saturation !== 1 ||
      s.gamma !== 1
    )
      filters.push(
        `eq=brightness=${s.brightness}:contrast=${s.contrast}:saturation=${s.saturation}:gamma=${s.gamma}`,
      );
    if (s.hue !== 0) filters.push(`hue=h=${s.hue}`);
    if (s.temperature !== 0)
      filters.push(
        `colorbalance=rs=${decimal(s.temperature * 0.25)}:bs=${decimal(-s.temperature * 0.25)}:rm=${decimal(s.temperature * 0.2)}:bm=${decimal(-s.temperature * 0.2)}:rh=${decimal(s.temperature * 0.1)}:bh=${decimal(-s.temperature * 0.1)}:pl=1`,
      );
    if (s.noise > 0)
      filters.push(`noise=alls=${decimal(s.noise * 30)}:allf=t+u`);
    if (s.sharpness > 0) filters.push(`unsharp=5:5:${s.sharpness}:5:5:0`);
    // Treat source pixels before adding any contain padding, including the side
    // margins of a portrait original. Temporal effects still use the output FPS.
    if (s.blackBands?.enabled) filters.splice(sourceEffectsIndex, 0, ...filters.splice(colorEffectsIndex));
    // At 1, blend equally with the previous frame; smoothing averages a longer window.
    if (s.blend > 0)
      filters.push(
        `tmix=frames=2:weights='${decimal(1 - s.blend / 2)} ${decimal(s.blend / 2)}'`,
      );
    if (s.frameBlend > 0) {
      // Limit history to approximately 128 MiB of 4:2:0 pixels for large exports.
      const memoryFrames = Math.max(
        2,
        Math.floor((128 * 1024 * 1024) / (width * height * 1.5)),
      );
      const frames = Math.max(
        2,
        Math.min(60, memoryFrames, Math.round(s.frameBlend * fps) + 1),
      );
      filters.push(`tmix=frames=${frames}`);
    }
    // Cutaways are inserted beneath editorial text so captions remain readable
    // and the original/replacement audio remains the only mapped sound track.
    const cutawayFilterIndex = filters.length;
    if (s.hookText.trim() && s.hookDuration > 0) {
      const filename = `hook-${randomUUID()}.txt`;
      const filePath = path.join(workDir, filename);
      temporary.push(filePath);
      const size = Math.max(10, Math.round(Math.min(width, height) * 0.054));
      const columns = Math.max(8, Math.floor((width * 0.86) / (size * 0.64)));
      await writeFile(filePath, wrapHook(s.hookText, columns), "utf8");
      filters.push(
        `drawtext=${await drawTextFont()}:textfile=${filename}:expansion=none:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=${Math.max(4, Math.round(size * 0.45))}:line_spacing=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=h*0.08:fix_bounds=1:enable='lt(t,${decimal(Math.min(s.hookDuration, duration))})'`,
      );
    }
    for (const callout of s.callouts ?? []) {
      if (!callout.text.trim() || callout.start >= duration) continue;
      const filename = `callout-${randomUUID()}.txt`;
      const filePath = path.join(workDir, filename);
      temporary.push(filePath);
      const size = Math.max(10, Math.round(Math.min(width, height) * 0.047));
      const columns = Math.max(8, Math.floor((width * 0.84) / (size * 0.64)));
      await writeFile(filePath, wrapHook(callout.text, columns), "utf8");
      filters.push(
        `drawtext=${await drawTextFont()}:textfile=${filename}:expansion=none:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.70:boxborderw=${Math.max(4, Math.round(size * 0.45))}:line_spacing=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=h*0.24:fix_bounds=1:enable='gte(t,${decimal(callout.start)})*lt(t,${decimal(Math.min(callout.end, duration))})'`,
      );
    }
    const decorations: string[] = [];
    if (s.blackBands?.enabled) {
      decorations.push(`pad=${canvas.width}:${canvas.height}:0:${top}:color=black`);
      for (const [text, bandHeight, bandTop] of [
        [s.blackBands.topText, top, 0],
        [s.blackBands.bottomText, bottom, top + height],
      ] as const) {
        if (!text.trim()) continue;
        const layout = bandTextLayout(text, width, canvas.height, bandHeight, s.blackBands.fontPercent);
        const filename = `band-${randomUUID()}.txt`;
        const filePath = path.join(workDir, filename);
        temporary.push(filePath);
        await writeFile(filePath, layout.text, "utf8");
        decorations.push(`drawtext=${await drawTextFont()}:textfile=${filename}:expansion=none:fontsize=${decimal(layout.fontSize)}:fontcolor=white:line_spacing=${decimal(layout.fontSize * 0.25)}:x=(w-text_w)/2:y=${bandTop}+(${bandHeight}-text_h)/2:fix_bounds=1`);
      }
    }
    if (options.subtitlePath) {
      const subtitle = await subtitleFilter(options.subtitlePath, s.captionStyle, workDir, temporary, options.captionWords);
      (s.blackBands?.enabled ? decorations : filters).push(subtitle);
    }
    if (!footageTimes.inserts.length) filters.push(...decorations);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "2",
    ];
    if (editList)
      args.push(
        "-copyts",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        `concat,${FORMATS}`,
        "-f",
        "concat",
        "-safe",
        concatSafe,
        "-segment_time_metadata",
        "1",
        "-i",
        editList,
      );
    else
      args.push(
        ...SAFE_INPUT,
        "-ss",
        decimal(start),
        "-t",
        decimal(clipLength),
        "-i",
        input,
      );
    const replacementAudio = !!options.audioPath && !s.muted;
    if (replacementAudio)
      args.push(
        "-threads",
        "2",
        "-stream_loop",
        "-1",
        ...SAFE_INPUT,
        "-i",
        await localFile(options.audioPath!),
      );
    const graph: string[] = [];
    const hasInserts = footageTimes.inserts.length > 0;
    if (supportingVisuals.length) {
      graph.push(`[0:V:0]${filters.slice(0, cutawayFilterIndex).join(",")}[picture0]`);
      for (const [index, visual] of supportingVisuals.entries()) {
        const local = await localFile(visual.path);
        const media = await probeMedia(local);
        const length = visual.end - visual.start;
        if ((visual.sourceStart ?? 0) + length > media.duration + 0.05)
          throw new Error(
            "Supporting visual is shorter than its selected interval",
          );
        args.push(
          "-threads",
          "2",
          ...SAFE_INPUT,
          "-ss",
          decimal(visual.sourceStart ?? 0),
          "-t",
          decimal(length),
          "-i",
          local,
        );
        const inputIndex = index + (replacementAudio ? 2 : 1);
        const supportingCrop = focalCrop(String(width), String(height),
          decimal(visual.focalPoint?.x ?? 0.5), decimal(visual.focalPoint?.y ?? 0.5));
        const fit = visual.fit === "contain"
          ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
          : `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,${supportingCrop}`;
        graph.push(
          `[${inputIndex}:V:0]trim=duration=${decimal(length)},setpts=PTS-STARTPTS+${decimal(visual.start)}/TB,${fit},setsar=1,fps=${decimal(fps)},format=yuv420p[cutaway${index}]`,
          `[picture${index}][cutaway${index}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:enable='gte(t,${decimal(visual.start)})*lt(t,${decimal(visual.end)})'[picture${index + 1}]`,
        );
      }
      graph.push(
        `[picture${supportingVisuals.length}]${filters.slice(cutawayFilterIndex).join(",") || "null"}[edited]`,
      );
    } else if (hasInserts) graph.push(`[0:V:0]${filters.join(",")}[edited]`);
    else args.push("-map", "0:V:0", "-vf", filters.join(","));
    const inputInsertionIndex = args.length;
    if (graph.length && !hasInserts) args.push("-filter_complex", graph.join(";"), "-map", "[edited]");
    args.push("-filter_threads", "1", "-filter_complex_threads", "1");
    const hasAudio = !s.muted && (replacementAudio || source.hasAudio || footage.some(clip => clip.placement.mode === "insert" && clip.placement.audio === "clip" && clip.hasAudio));
    if (hasAudio) {
      if (!hasInserts) args.push("-map", replacementAudio ? "1:a:0" : "0:a:0");
      const audioFilters = replacementAudio
        ? ["asetpts=PTS-STARTPTS"]
        : [
            ...(segments
              ? ["aselect=concatdec_select", "aresample=async=1:first_pts=0"]
              : []),
            `atrim=duration=${decimal(clipLength)}`,
            "asetpts=PTS-STARTPTS",
            // FFmpeg 6 can stall when the identity tempo filter feeds loudnorm.
            // At normal speed it adds buffering without changing the audio.
            ...(s.speed === 1 ? [] : [`atempo=${s.speed}`]),
          ];
      if (s.smoothCuts && segments && segments.length > 1 && !replacementAudio) {
        let boundary = 0;
        const dips = segments.slice(0, -1).map(segment => {
          boundary += (segment.end - segment.start) / s.speed;
          return `min(1,abs(t-${decimal(boundary)})/0.004)`;
        });
        // A 4 ms dip on each side softens hard joins without shifting either stream.
        // Use the export's explicit stereo layout: FFmpeg 8 can crash while
        // negotiating aeval's "same" layout from mono input to stereo output.
        const gain = dips.join("*");
        audioFilters.push("aformat=channel_layouts=stereo",
          `aeval=exprs='val(0)*(${gain})|val(1)*(${gain})':channel_layout=stereo`);
      }
      // Shape tone, noise and dynamics before measuring loudness, so the
      // normalizer works on the sound that is actually exported.
      audioFilters.push(...audioModifierFilters(s));
      if (s.normalizeAudio) audioFilters.push(...audioNormalizationFilters());
      audioFilters.push(
        `volume=${s.volume}`,
        "apad",
        `atrim=duration=${decimal(duration)}`,
      );
      // Without inserted footage the export ends on this trim, so the fades can
      // be measured against it here. Inserts extend the timeline and fade below.
      if (!hasInserts) audioFilters.push(...audioFadeFilters(s, duration));
      if (hasInserts) graph.push(replacementAudio || source.hasAudio
        ? `[${replacementAudio ? "1:a:0" : "0:a:0"}]${audioFilters.join(",")},aresample=48000,aformat=channel_layouts=stereo[baseaudio]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${decimal(duration)}[baseaudio]`);
      else args.push("-af", audioFilters.join(","));
      args.push(
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
      );
    } else args.push("-an");
    if (hasInserts) {
      const ownInputs: string[] = [];
      exportDuration = await composeFootage({ graph, footage, duration, fps, width, height, audio: hasAudio,
        volume: s.volume, normalizeAudio: !!s.normalizeAudio, modifiers: audioModifierFilters(s),
        firstInput: (replacementAudio ? 2 : 1) + supportingVisuals.length,
        addInput: async (clip, length) => { ownInputs.push("-threads", "2", ...SAFE_INPUT, "-ss", decimal(clip.placement.start), "-t", decimal(length), "-i", await localFile(clip.path)); } });
      args.splice(inputInsertionIndex, 0, ...ownInputs);
      const fades = hasAudio ? audioFadeFilters(s, exportDuration) : [];
      if (fades.length) graph.push(`[footageaudio]${fades.join(",")}[fadedaudio]`);
      if (decorations.length) graph.push(`[footagevideo]${decorations.join(",")}[decoratedvideo]`);
      args.push("-filter_complex", graph.join(";"), "-map", decorations.length ? "[decoratedvideo]" : "[footagevideo]");
      if (hasAudio) args.push("-map", fades.length ? "[fadedaudio]" : "[footageaudio]");
    }
    if (options.maximumOutputDuration !== undefined) {
      if (!Number.isFinite(options.maximumOutputDuration) || options.maximumOutputDuration <= 0) throw new Error("Invalid preview duration");
      exportDuration = Math.min(exportDuration, options.maximumOutputDuration);
    }
    // Old saved settings cannot disable metadata cleanup or invent camera tags.
    args.push(...CLEAN_EXPORT_METADATA_ARGS);
    // Disabling encoder lookahead also avoids FFmpeg 8 scheduler stalls when
    // accelerated video needs more decoded frames than its paired audio queue.
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-t",
      decimal(exportDuration),
      "-progress",
      "pipe:1",
      "-nostats",
      "-f",
      "mp4",
      output,
    );
    let buffered = "";
    let lastProgress = 0;
    options.onProgress(0);
    await run("ffmpeg", args, {
      cwd: workDir,
      signal,
      onStdout(chunk) {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("out_time_us=")) continue;
          const seconds = Number(line.slice("out_time_us=".length)) / 1_000_000;
          const progress = clamp((seconds / exportDuration) * 100, 0, 99);
          if (Number.isFinite(progress) && progress > lastProgress) {
            lastProgress = progress;
            options.onProgress(progress);
          }
        }
      },
    });
    const outputInfo = await stat(output);
    if (outputInfo.size < 100)
      throw new Error("The export did not produce a valid video");
    assertCleanExportMetadata(await probe(output, signal));
    options.onProgress(100);
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    await Promise.all(
      temporary.map((file) => rm(file, { recursive: true, force: true }).catch(() => {})),
    );
  }
}
