import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RemixSettings } from "../shared/types.js";
import type { SupportingVisual } from "./visuals.js";
import { wrapEditorialText as wrapHook } from "../shared/framing.js";

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
    child.once("close", (code) => {
      cleanup();
      if (options.signal?.aborted) reject(abortError());
      else if (timedOut)
        reject(new Error(`${binary} exceeded the processing time limit`));
      else if (code !== 0)
        reject(
          new Error(
            `${binary} failed: ${stderr.trim().slice(-4_000) || `exit ${code}`}`,
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
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}
interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
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
): Promise<void> {
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
  for (const key of ["normalizeAudio", "autoMotion"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean")
      throw new Error(`Invalid ${key} setting`);
  }
  if (!validFocalPoint(settings.focalPoint) || settings.segments?.some(segment => !validFocalPoint(segment.focalPoint)))
    throw new Error("Focal points must contain x and y coordinates between 0 and 1");
  const style = settings.captionStyle;
  if (style !== undefined && (!style || typeof style !== "object" ||
    !Number.isFinite(style.fontSize) || style.fontSize < 12 || style.fontSize > 40 ||
    !Number.isFinite(style.bottomPercent) || style.bottomPercent < 5 || style.bottomPercent > 80))
    throw new Error("Caption style needs a font size from 12 to 40 and a bottom margin from 5 to 80 percent");
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
    offset += (segment.end - segment.start) / settings.speed;
    return { end: offset, value: segment.focalPoint?.[axis] ?? fallback };
  });
  let expression = decimal(choices.at(-1)!.value);
  for (let index = choices.length - 2; index >= 0; index--) {
    const choice = choices[index]!;
    expression = `if(lt(t,${decimal(choice.end)}),${decimal(choice.value)},${expression})`;
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
  if (settings.fit === "contain" || settings.fit === "blur") {
    if (width / height > target) height = width / target;
    else width = height * target;
  } else {
    if (width / height > target) width = height * target;
    else height = width / target;
  }
  const cap =
    settings.resolution === "source"
      ? 1
      : Math.min(1, Number(settings.resolution) / Math.min(width, height));
  return { width: even(width * cap), height: even(height * cap) };
}


async function fontOption(): Promise<string> {
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
  return "font=Sans";
}

async function canonicalSubtitles(filePath: string): Promise<string> {
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
    canonical.push(
      `${canonical.length + 1}\n${beginStamp} --> ${endStamp}\n${lines.join("\n")}`,
    );
  }
  // A canonical numeric cue header ensures the subtitle filter's independent
  // demuxer cannot interpret an uploaded file as a playlist or another format.
  return `${canonical.join("\n\n")}\n`;
}

export interface RenderOptions {
  input: string;
  output: string;
  settings: RemixSettings;
  source: MediaInfo;
  audioPath?: string;
  subtitlePath?: string;
  supportingVisuals?: SupportingVisual[];
  workDir: string;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
  /** Preserve full-edit camera movement when rendering only an opening preview. */
  motionDuration?: number;
}

/** SRT timings and replacement audio refer to the final output timeline. */
export async function renderVideo(options: RenderOptions): Promise<void> {
  const { settings: s, source, signal } = options;
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
  const { width, height } = geometry(source, s);
  const supportingVisuals = options.supportingVisuals ?? [];
  if (
    supportingVisuals.length > 3 ||
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
      "Supporting visuals need valid times within the edited video (maximum 3)",
    );
  const temporary: string[] = [];
  try {
    // The concat demuxer seeks each requested interval in order. Its frame
    // metadata lets select/aselect discard keyframe preroll without another
    // encoding pass or dozens of simultaneously buffered decoder branches.
    let editList: string | undefined;
    if (segments) {
      const sourceName = `edit-source-${randomUUID()}.media`;
      const sourceLink = path.join(workDir, sourceName);
      editList = path.join(workDir, `edit-${randomUUID()}.ffconcat`);
      temporary.push(sourceLink, editList);
      await symlink(input, sourceLink);
      await writeFile(
        editList,
        `ffconcat version 1.0\n${segments.map((segment) => `file ${sourceName}\ninpoint ${decimal(segment.start)}\noutpoint ${decimal(segment.end)}\nduration ${decimal(segment.end - segment.start)}`).join("\n")}\n`,
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
    ];
    const focalX = focalExpression(s, "x");
    const focalY = focalExpression(s, "y");
    if (s.fit === "crop") {
      const aspect = decimal(width / height);
      filters.push(focalCrop(
        `max(2,trunc(min(iw,ih*${aspect})/${s.zoom}/2)*2)`,
        `max(2,trunc(min(ih,iw/${aspect})/${s.zoom}/2)*2)`,
        focalX, focalY,
      ));
    } else if (s.zoom !== 1) filters.push(focalCrop(
      `max(2,trunc(iw/${s.zoom}/2)*2)`, `max(2,trunc(ih/${s.zoom}/2)*2)`, focalX, focalY,
    ));
    // Points describe subjects in the original source. Mirroring after the
    // crop keeps that same subject instead of selecting its opposite edge.
    if (s.mirror) filters.push("hflip");
    const motion = `zoompan=z='1+0.04*min(on/${decimal(Math.max(1, (options.motionDuration ?? duration) * fps - 1))},1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${width}x${height}:fps=${decimal(fps)}`;
    if (s.fit === "blur")
      filters.push(
        `fps=${decimal(fps)},split=2[blurback][blurfront];[blurback]scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height},gblur=sigma=${decimal(Math.max(8, Math.min(40, Math.min(width, height) * 0.045)))}:steps=2,eq=brightness=-0.12${s.autoMotion ? `,${motion}` : ""}[blurfill];[blurfront]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2[blurpicture];[blurfill][blurpicture]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1`,
      );
    else if (s.fit === "contain")
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      );
    else
      filters.push(
        `scale=${width}:${height}`,
      );
    filters.push("setsar=1", `fps=${decimal(fps)}`, "format=yuv420p");
    if (s.autoMotion && s.fit !== "blur") filters.push(motion);
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
        `drawtext=${await fontOption()}:textfile=${filename}:expansion=none:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=${Math.max(4, Math.round(size * 0.45))}:line_spacing=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=h*0.08:fix_bounds=1:enable='lt(t,${decimal(Math.min(s.hookDuration, duration))})'`,
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
        `drawtext=${await fontOption()}:textfile=${filename}:expansion=none:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.70:boxborderw=${Math.max(4, Math.round(size * 0.45))}:line_spacing=${Math.round(size * 0.25)}:x=(w-text_w)/2:y=h*0.24:fix_bounds=1:enable='gte(t,${decimal(callout.start)})*lt(t,${decimal(Math.min(callout.end, duration))})'`,
      );
    }
    if (options.subtitlePath) {
      const filename = `captions-${randomUUID()}.srt`;
      const filePath = path.join(workDir, filename);
      temporary.push(filePath);
      await writeFile(
        filePath,
        await canonicalSubtitles(options.subtitlePath),
        "utf8",
      );
      filters.push(
        // FFmpeg's SRT-to-ASS decoder uses a 384 x 288 script canvas. ASS
        // margins are script pixels, so converting here preserves percentages
        // across source resolutions and portrait/landscape exports.
        `subtitles=filename=${filename}:charenc=UTF-8:force_style='FontName=DejaVu Sans,FontSize=${decimal(s.captionStyle?.fontSize ?? 20)},PrimaryColour=&H00FFFFFF,OutlineColour=&H00151515,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=${Math.round((s.captionStyle?.bottomPercent ?? (100 / 12)) * 288 / 100)}'`,
      );
    }
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
        "1",
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
    if (supportingVisuals.length) {
      const graph = [
        `[0:V:0]${filters.slice(0, cutawayFilterIndex).join(",")}[picture0]`,
      ];
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
        graph.push(
          `[${inputIndex}:V:0]trim=duration=${decimal(length)},setpts=PTS-STARTPTS+${decimal(visual.start)}/TB,scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,${supportingCrop},setsar=1,fps=${decimal(fps)},format=yuv420p[cutaway${index}]`,
          `[picture${index}][cutaway${index}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:enable='gte(t,${decimal(visual.start)})*lt(t,${decimal(visual.end)})'[picture${index + 1}]`,
        );
      }
      graph.push(
        `[picture${supportingVisuals.length}]${filters.slice(cutawayFilterIndex).join(",") || "null"}[edited]`,
      );
      args.push("-filter_complex", graph.join(";"), "-map", "[edited]");
    } else args.push("-map", "0:V:0", "-vf", filters.join(","));
    args.push("-filter_threads", "1", "-filter_complex_threads", "1");
    if (!s.muted && (replacementAudio || source.hasAudio)) {
      args.push("-map", replacementAudio ? "1:a:0" : "0:a:0");
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
      if (s.normalizeAudio) audioFilters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
      audioFilters.push(
        `volume=${s.volume}`,
        "apad",
        `atrim=duration=${decimal(duration)}`,
      );
      args.push(
        "-af",
        audioFilters.join(","),
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
    args.push(
      "-sn",
      "-dn",
      "-map_metadata",
      s.stripMetadata ? "-1" : "0",
      "-map_chapters",
      "-1",
      "-metadata:s:v:0",
      "rotate=0",
    );
    // Legacy saved settings can contain device profiles. Never invent capture
    // make/model metadata; metadata retention only preserves source information.
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
      "-movflags",
      "+faststart+use_metadata_tags",
      "-t",
      decimal(duration),
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
          const progress = clamp((seconds / duration) * 100, 0, 99);
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
    options.onProgress(100);
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    await Promise.all(
      temporary.map((file) => rm(file, { force: true }).catch(() => {})),
    );
  }
}
