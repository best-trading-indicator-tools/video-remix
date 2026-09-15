import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Transcript } from "../shared/types.js";

const FORMATS =
  "mov,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf,wav,mp3,flac,aac,aiff,nut";
const abortError = () =>
  Object.assign(new Error("Transcription cancelled"), { name: "AbortError" });
const settings = () => ({
  python: path.resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  ),
  script: path.resolve("scripts/transcribe.py"),
  model: process.env.WHISPER_MODEL || "small",
  cache: path.resolve(
    process.env.WHISPER_CACHE_DIR ||
      path.join(process.env.DATA_DIR || "data", "models"),
  ),
});
interface CommandOptions {
  signal?: AbortSignal;
  timeout: number;
  onLine?: (line: string) => void;
}
function command(
  binary: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        OMP_NUM_THREADS: "2",
        OPENBLAS_NUM_THREADS: "2",
        MKL_NUM_THREADS: "2",
        TOKENIZERS_PARALLELISM: "false",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timeoutReached = false;
    let outputTooLarge = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
      }
    };
    const timer = setTimeout(() => {
      timeoutReached = true;
      terminate();
    }, options.timeout);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", terminate);
    };
    options.signal?.addEventListener("abort", terminate, { once: true });
    if (options.signal?.aborted) terminate();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputTooLarge) return;
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) {
        outputTooLarge = true;
        stdout = "";
        terminate();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12000);
      pending = (pending + chunk).slice(-64000);
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) options.onLine?.(line);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (options.signal?.aborted) return reject(abortError());
      if (timeoutReached)
        return reject(
          new Error(
            "Local transcription exceeded its processing time limit. Try a shorter clip or a smaller WHISPER_MODEL.",
          ),
        );
      if (outputTooLarge)
        return reject(
          new Error(
            "The transcript is too large. Split the source into shorter videos.",
          ),
        );
      if (code !== 0) {
        const errors = stderr.trim().split("\n").reverse();
        for (const line of errors) {
          try {
            const event = JSON.parse(line) as { type?: string; error?: string };
            if (event.type === "error" && typeof event.error === "string")
              return reject(new Error(event.error));
          } catch {
            /* FFmpeg diagnostics and native library warnings are plain text. */
          }
        }
        return reject(
          new Error(
            `Local transcription failed: ${stderr.trim().slice(-3000) || `exit ${code}`}`,
          ),
        );
      }
      resolve(stdout);
    });
  });
}

let availability:
  | { key: string; until: number; result: Promise<boolean> }
  | undefined;
export async function transcriptionAvailable(): Promise<boolean> {
  const config = settings();
  const key = JSON.stringify(config);
  if (availability?.key === key && availability.until > Date.now())
    return availability.result;
  const check = async () => {
    try {
      await Promise.all([access(config.python), access(config.script)]);
      const result = await command(
        config.python,
        [
          config.script,
          "--check",
          "--model",
          config.model,
          "--cache-dir",
          config.cache,
        ],
        { timeout: 30000 },
      );
      return (JSON.parse(result) as { available?: unknown }).available === true;
    } catch {
      return false;
    }
  };
  const entry = { key, until: Date.now() + 30000, result: check() };
  availability = entry;
  void entry.result.then((available) => {
    entry.until = Date.now() + (available ? 30000 : 3000);
  });
  return entry.result;
}

const time = z.number().finite().nonnegative();
const wordSchema = z.object({
  start: time,
  end: time,
  word: z.string(),
  probability: z.number().finite().min(0).max(1).optional(),
});
export const transcriptSchema = z.object({
  language: z.string(),
  duration: time.positive(),
  segments: z.array(
    z.object({
      start: time,
      end: time,
      text: z.string(),
      words: z.array(wordSchema),
    }),
  ),
});

export async function transcribeLocal(options: {
  input: string;
  workDir: string;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
}): Promise<Transcript> {
  if (options.signal.aborted) throw abortError();
  const config = settings();
  const input = await realpath(path.resolve(options.input));
  const info = await stat(input);
  if (!info.isFile() || info.size === 0)
    throw new Error("Transcription requires a non-empty local media file.");
  const directory = path.resolve(options.workDir, `transcribe-${randomUUID()}`);
  const audio = path.join(directory, "audio.wav");
  await mkdir(directory, { recursive: true });
  let lastProgress = 0;
  const progress = (value: number) => {
    const next = Math.max(lastProgress, Math.min(100, Math.round(value)));
    lastProgress = next;
    options.onProgress(next);
  };
  try {
    progress(0);
    await command(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        FORMATS,
        "-i",
        input,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-t",
        "86400",
        "-threads",
        "2",
        audio,
      ],
      { signal: options.signal, timeout: 10 * 60 * 1000 },
    );
    progress(5);
    const duration = Math.max(1, (await stat(audio)).size / 32000);
    const output = await command(
      config.python,
      [
        config.script,
        "--input",
        audio,
        "--model",
        config.model,
        "--cache-dir",
        config.cache,
      ],
      {
        signal: options.signal,
        timeout: Math.min(
          6 * 60 * 60 * 1000,
          Math.max(120000, duration * 12000),
        ),
        onLine(line) {
          try {
            const event = JSON.parse(line) as {
              type?: string;
              progress?: unknown;
            };
            if (
              event.type === "progress" &&
              typeof event.progress === "number" &&
              Number.isFinite(event.progress)
            )
              progress(5 + event.progress * 0.94);
          } catch {
            /* Non-JSON library diagnostics are retained for failures. */
          }
        },
      },
    );
    if (options.signal.aborted) throw abortError();
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw new Error("The local speech model returned an invalid transcript.");
    }
    const transcript = transcriptSchema.parse(value);
    for (const segment of transcript.segments) {
      if (
        segment.end <= segment.start ||
        segment.end > transcript.duration + 0.1
      )
        throw new Error(
          "The local speech model returned invalid segment timestamps.",
        );
      for (const word of segment.words) {
        if (word.end <= word.start || word.end > transcript.duration + 0.1)
          throw new Error(
            "The local speech model returned invalid word timestamps.",
          );
      }
    }
    progress(100);
    return transcript;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
