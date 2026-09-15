import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RemixSettings } from "../shared/types.js";

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

async function probe(filePath: string): Promise<ProbeResult> {
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
    { timeout: 30_000 },
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

export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const info = await probe(filePath);
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
    { timeout: 30_000 },
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
    settings.trimEnd !== null &&
    (!Number.isFinite(settings.trimEnd) ||
      settings.trimEnd <= settings.trimStart)
  )
    throw new Error("Trim end must be after trim start");
  if (
    !["original", "9:16", "1:1", "4:5", "16:9"].includes(settings.aspect) ||
    !["crop", "contain"].includes(settings.fit) ||
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
}

function geometry(
  source: MediaInfo,
  settings: RemixSettings,
): { width: number; height: number } {
  let width = source.width;
  let height = source.height;
  const target =
    settings.aspect === "original"
      ? width / height
      : ratio(settings.aspect, ":");
  if (settings.fit === "contain") {
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

function wrapHook(text: string, columns: number): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const output: string[] = [];
      let current = "";
      for (const word of line.split(/\s+/u)) {
        if (!word) continue;
        if (current && Array.from(`${current} ${word}`).length > columns) {
          output.push(current);
          current = "";
        }
        const letters = Array.from(word);
        while (letters.length > columns)
          output.push(letters.splice(0, columns).join(""));
        if (letters.length)
          current += `${current ? " " : ""}${letters.join("")}`;
      }
      if (current) output.push(current);
      return output.join("\n");
    })
    .join("\n");
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
  workDir: string;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
}

/** SRT timings and replacement audio refer to the final output timeline. */
export async function renderVideo(options: RenderOptions): Promise<void> {
  const { settings: s, source, signal } = options;
  validateSettings(s);
  if (signal.aborted) throw abortError();
  const input = await localFile(options.input);
  const output = path.resolve(options.output);
  if (input === output) throw new Error("Output must be different from source");
  const workDir = path.resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(output), { recursive: true });
  const sourceEnd = Math.min(s.trimEnd ?? source.duration, source.duration);
  const clipLength = sourceEnd - s.trimStart;
  if (!Number.isFinite(clipLength) || clipLength <= 0.04)
    throw new Error("Select at least 0.04 seconds inside the source video");
  // Shift the whole trim window, maintaining its duration and clamping to the source.
  const start = clamp(
    s.trimStart + s.timeShift,
    0,
    Math.max(0, source.duration - clipLength),
  );
  const duration = clipLength / s.speed;
  const fps = s.fps === "source" ? source.fps : Number(s.fps);
  const { width, height } = geometry(source, s);
  const temporary: string[] = [];
  try {
    const filters = [
      `trim=duration=${decimal(clipLength)}`,
      `setpts=(PTS-STARTPTS)/${s.speed}`,
      // Work in display pixels so anamorphic and autorotated inputs export correctly.
      `scale=${even(source.width)}:${even(source.height)}:flags=bicubic`,
      "setsar=1",
    ];
    if (s.zoom !== 1)
      filters.push(
        `crop=w='trunc(iw/${s.zoom}/2)*2':h='trunc(ih/${s.zoom}/2)*2'`,
      );
    if (s.mirror) filters.push("hflip");
    if (s.fit === "contain")
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      );
    else
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`,
        `crop=${width}:${height}`,
      );
    filters.push("setsar=1", `fps=${decimal(fps)}`, "format=yuv420p");
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
        `subtitles=filename=${filename}:charenc=UTF-8:force_style='FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00151515,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=24'`,
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
      ...SAFE_INPUT,
      "-ss",
      decimal(start),
      "-t",
      decimal(clipLength),
      "-i",
      input,
    ];
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
    args.push(
      "-map",
      "0:V:0",
      "-vf",
      filters.join(","),
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
    );
    if (!s.muted && (replacementAudio || source.hasAudio)) {
      args.push("-map", replacementAudio ? "1:a:0" : "0:a:0");
      const audioFilters = replacementAudio
        ? ["asetpts=PTS-STARTPTS"]
        : [
            `atrim=duration=${decimal(clipLength)}`,
            "asetpts=PTS-STARTPTS",
            `atempo=${s.speed}`,
          ];
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
    if (s.device !== "none" && s.device.trim()) {
      const make = /ray.ban|meta/i.test(s.device) ? "Meta" : "Apple";
      args.push(
        "-metadata",
        `make=${make}`,
        "-metadata",
        `model=${s.device}`,
        "-metadata",
        `com.apple.quicktime.make=${make}`,
        "-metadata",
        `com.apple.quicktime.model=${s.device}`,
      );
    }
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
