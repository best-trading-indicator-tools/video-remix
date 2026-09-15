import type { QualityIssue, QualityReport, RemixSettings } from "../shared/types.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";
import { geometry, probeMedia, type MediaInfo } from "./engine.js";
import type { SupportingVisual } from "./visuals.js";

const FULL_SCAN_LIMIT = 180;
const SAMPLE_LENGTH = 12;
const SCAN_FPS = 4;
type Interval = { start: number; end: number };

function coveredByGraphics(interval: Interval, visuals: SupportingVisual[]): boolean {
  let covered = interval.start;
  for (const visual of visuals.filter(item => item.kind === "graphic").sort((a, b) => a.start - b.start)) {
    if (visual.start > covered + 0.001) break;
    if (visual.end > covered) covered = visual.end;
    if (covered >= interval.end - 0.001) return true;
  }
  return false;
}

function detectedIntervals(log: string, window: Interval): { black: Interval[]; frozen: Interval[] } {
  const black: Interval[] = [];
  const frozen: Interval[] = [];
  const toInterval = (start: number, end: number): Interval | undefined => {
    const interval = { start: Math.max(window.start, window.start + start), end: Math.min(window.end, window.start + end) };
    return Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start
      ? { start: Number(interval.start.toFixed(3)), end: Number(interval.end.toFixed(3)) } : undefined;
  };
  for (const match of log.matchAll(/black_start:([\d.e+-]+)\s+black_end:([\d.e+-]+)\s+black_duration:([\d.e+-]+)/gu)) {
    const interval = toInterval(Number(match[1]), Number(match[2]));
    if (interval) black.push(interval);
  }
  let freezeStart: number | undefined;
  for (const match of log.matchAll(/lavfi\.freezedetect\.freeze_(start|end):\s*([\d.e+-]+)/gu)) {
    if (match[1] === "start") freezeStart = Number(match[2]);
    else if (freezeStart !== undefined) {
      const interval = toInterval(freezeStart, Number(match[2]));
      if (interval) frozen.push(interval);
      freezeStart = undefined;
    }
  }
  // A freeze continuing to EOF has a start marker without an end marker.
  if (freezeStart !== undefined) {
    const interval = toInterval(freezeStart, window.end - window.start);
    if (interval) frozen.push(interval);
  }
  return { black, frozen };
}

/**
 * Local render checks are review heuristics, not a claim about editorial or
 * platform quality. Full means the entire timeline was scanned at low
 * resolution and four frames per second. Long exports inspect three 12-second
 * windows; callers must display the returned sampled scope to the reviewer.
 */
export async function inspectExport({ output, source, settings, audioPath, supportingVisuals = [], signal }: {
  output: string;
  source: MediaInfo;
  settings: RemixSettings;
  audioPath?: string;
  supportingVisuals?: SupportingVisual[];
  signal: AbortSignal;
}): Promise<QualityReport> {
  signal.throwIfAborted();
  const issues: QualityIssue[] = [];
  let scope: QualityReport["scope"] = "full";
  const budgetSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const add = (issue: QualityIssue) => {
    if (issues.length < 20) issues.push(issue);
    else if (!issues.some(item => item.code === "additional-findings"))
      issues.push({ code: "additional-findings", message: "More suspect intervals were found. Review the full video." });
  };
  try {
    const sourceLength = settings.segments
      ? settings.segments.reduce((sum, cut) => sum + cut.end - cut.start, 0)
      : Math.min(settings.trimEnd ?? source.duration, source.duration) - settings.trimStart;
    const expectedDuration = sourceLength / settings.speed;
    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) throw new Error("Invalid expected duration");
    const expectedSize = geometry(source, settings);
    const media = await probeMedia(output, budgetSignal);
    budgetSignal.throwIfAborted();
    scope = media.duration <= FULL_SCAN_LIMIT ? "full" : "sampled";
    const expectedFps = settings.fps === "source" ? source.fps : Number(settings.fps);
    const tolerance = Math.max(0.15, 2 / Math.max(1, expectedFps));
    if (Math.abs(media.duration - expectedDuration) > tolerance)
      add({ code: "duration-mismatch", message: `The video is ${media.duration.toFixed(2)} seconds; the saved edit expects ${expectedDuration.toFixed(2)} seconds.` });
    if (media.width !== expectedSize.width || media.height !== expectedSize.height)
      add({ code: "dimensions-mismatch", message: `The video is ${media.width} × ${media.height}; the saved framing expects ${expectedSize.width} × ${expectedSize.height}.` });
    const expectsAudibleAudio = !settings.muted && settings.volume > 0 && (source.hasAudio || Boolean(audioPath));
    if (expectsAudibleAudio && !media.hasAudio)
      add({ code: "missing-audio", message: "The exported video has no audio track although this edit expects sound." });
    const inspectAudio = expectsAudibleAudio && media.hasAudio;
    const windows = scope === "full" ? [{ start: 0, end: media.duration }] : [
      { start: 0, end: SAMPLE_LENGTH },
      { start: (media.duration - SAMPLE_LENGTH) / 2, end: (media.duration + SAMPLE_LENGTH) / 2 },
      { start: media.duration - SAMPLE_LENGTH, end: media.duration },
    ];
    const audioLevels: { mean: number; peak: number }[] = [];
    for (const window of windows) {
      budgetSignal.throwIfAborted();
      const { stdout, stderr } = await runLocal("ffmpeg", [
        "-hide_banner", "-loglevel", "info", "-nostdin", "-nostats", "-xerror",
        "-threads", "1", "-ss", String(window.start),
        ...MEDIA_INPUT_ARGS, "-i", output, "-t", String(window.end - window.start),
        "-map", "0:V:0", ...(inspectAudio ? ["-map", "0:a:0"] : ["-an"]),
        "-sn", "-dn", "-filter_threads", "1", "-filter_complex_threads", "1",
        "-vf", `setpts=PTS-STARTPTS,fps=${SCAN_FPS},scale=160:160:force_original_aspect_ratio=decrease,format=gray,blackdetect=d=0.4:pix_th=0.08:pic_th=0.98,freezedetect=n=-50dB:d=1.5`,
        ...(inspectAudio ? ["-af", "volumedetect", "-ac", "1", "-ar", "8000"] : []),
        "-threads", "1", "-progress", "pipe:1", "-f", "null", "-",
      ], { signal: budgetSignal, timeout: 45_000 });
      budgetSignal.throwIfAborted();
      const decoded = [...stdout.matchAll(/^frame=(\d+)$/gmu)].at(-1);
      if (!decoded || Number(decoded[1]) < Math.max(1, Math.floor((window.end - window.start) * SCAN_FPS) - 1))
        throw new Error("Incomplete video inspection");
      const detected = detectedIntervals(stderr, window);
      // A planned title card may deliberately be still, but a black frame can
      // mean that the card itself failed. The plan cannot establish that the
      // exported black pixels are intentional.
      for (const interval of detected.black)
        add({ code: "black-frames", message: "An almost black interval was detected. Preview it to confirm it is intentional.", ...interval });
      for (const interval of detected.frozen) if (!coveredByGraphics(interval, supportingVisuals))
        add({ code: "frozen-frames", message: "An interval shows very little picture movement. Check for a frozen or unintended still frame.", ...interval });
      if (inspectAudio) {
        const mean = /mean_volume:\s*(-?(?:[\d.]+|inf))\s*dB/u.exec(stderr);
        const peak = /max_volume:\s*(-?(?:[\d.]+|inf))\s*dB/u.exec(stderr);
        if (!mean || !peak) throw new Error("Audio inspection did not finish");
        const level = (value: string) => value === "-inf" ? -Infinity : Number(value);
        audioLevels.push({ mean: level(mean[1]!), peak: level(peak[1]!) });
      }
    }
    if (audioLevels.length && audioLevels.every(level => level.mean <= -60 && level.peak <= -50))
      add({ code: "near-silent-audio", message: scope === "full"
        ? "The exported audio is nearly silent. Check the soundtrack and volume."
        : "The audio is nearly silent in all three checked windows. Preview the soundtrack outside these samples too." });
  } catch {
    signal.throwIfAborted();
    add({ code: "inspection-failed", message: "The export checks could not finish. Preview this video before using it." });
  }
  signal.throwIfAborted();
  return { status: issues.length ? "review" : "pass", checkedAt: new Date().toISOString(), scope, issues };
}
