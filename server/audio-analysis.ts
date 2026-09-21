import type { AudioAnalysis } from "../shared/audio.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";

/** Half-second windows at 32 kHz; wide enough for the 5–16 kHz band to be real. */
const WINDOW_SAMPLES = 16_000;
const RATE = 32_000;
const MAX_SECONDS = 120;
const LEAST_WINDOWS = 8;
const TIMEOUT_MS = 60_000;

/** Named for what each band hears, not for its corner frequencies. */
const BANDS = {
  full: "",
  low: "lowpass=f=200:poles=2,",
  body: "highpass=f=200:poles=2,lowpass=f=1200:poles=2,",
  presence: "highpass=f=1200:poles=2,lowpass=f=4000:poles=2,",
  air: "highpass=f=5000:poles=2,",
} as const;

const input = (source: string, start: number, seconds: number) => [
  "-hide_banner", "-nostdin", "-threads", "1",
  ...(start > 0 ? ["-ss", start.toFixed(3)] : []), "-t", seconds.toFixed(3),
  ...MEDIA_INPUT_ARGS, "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn",
  "-ac", "1", "-ar", String(RATE),
];

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index]!;
}

/**
 * Measure the soundtrack of one interval of a media file. Six short decodes run
 * together: one reports the level of every half-second window, the others the
 * mean level of a frequency band. Band levels are returned relative to the
 * full-band mean, so a quiet recording and a loud one of the same room produce
 * the same numbers. Returns null when the file has no measurable audio, which
 * callers treat as "leave the sound alone" rather than as a failure.
 */
export async function analyzeAudio(source: string, options: {
  start?: number;
  duration?: number;
  signal?: AbortSignal;
}): Promise<AudioAnalysis | null> {
  const start = Math.max(0, options.start ?? 0);
  const seconds = Math.min(MAX_SECONDS, Math.max(1, options.duration ?? MAX_SECONDS));
  const signal = options.signal;
  try {
    const [windows, ...bands] = await Promise.all([
      // volumedetect and astats only report at info level.
      runLocal("ffmpeg", [...input(source, start, seconds), "-loglevel", "error", "-af",
        `asetnsamples=n=${WINDOW_SAMPLES},astats=metadata=1:reset=1,` +
        "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
        "-f", "null", "-"], { signal, timeout: TIMEOUT_MS }),
      ...Object.values(BANDS).map(band => runLocal("ffmpeg",
        [...input(source, start, seconds), "-loglevel", "info", "-af", `${band}volumedetect`, "-f", "null", "-"],
        { signal, timeout: TIMEOUT_MS })),
    ]);
    const levels = [...windows.stdout.matchAll(/^lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)$/gmu)]
      .map(match => Number(match[1]))
      .filter(value => Number.isFinite(value))
      .sort((first, second) => first - second);
    const means = bands.map(band => {
      const match = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/u.exec(band.stderr);
      return match ? Number(match[1]) : Number.NaN;
    });
    if (levels.length < LEAST_WINDOWS || means.some(value => !Number.isFinite(value))) return null;
    const [full, low, body, presence, air] = means as [number, number, number, number, number];
    return {
      quietDb: percentile(levels, 0.05),
      medianDb: percentile(levels, 0.5),
      loudDb: percentile(levels, 0.95),
      lowDb: low - full,
      bodyDb: body - full,
      presenceDb: presence - full,
      airDb: air - full,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}
