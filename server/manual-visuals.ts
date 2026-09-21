import path from "node:path";
import { DEFAULT_BROLL_MAX_COVERAGE, type Transcript } from "../shared/types.js";
import { manualPreviewInterval, manualSequencePreview } from "../shared/manual.js";
import { getVisualSources } from "../shared/visual-sources.js";
import { footageTimeline } from "../shared/own-footage.js";
import { sourceTranscript } from "./auto.js";
import { retimeTranscript } from "./auto-plan.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";
import { transcriptionAvailable, transcribeLocal } from "./transcription.js";
import { prepareSupportingVisuals } from "./supporting-plan.js";
import type { StoredBroll, StoredJob, StoredSource } from "./store.js";

const dependencies = { available: transcriptionAvailable, sourceTranscript, transcribe: transcribeLocal, prepare: prepareSupportingVisuals };

/** Supporting shots use the manual edit's clock; they never choose or change its cuts. */
export async function prepareManualVisuals(input: {
  source: StoredSource; job: StoredJob; assets: StoredBroll[]; audioPath?: string;
  workDir: string; signal: AbortSignal; onPhase: (phase: string, progress: number) => void;
}, overrides: Partial<typeof dependencies> = {}) {
  const { source, job, workDir, signal, onPhase, audioPath } = input;
  const options = job.settings;
  signal.throwIfAborted();
  if (!getVisualSources(options).length || (options.brollMaxCoverage ?? DEFAULT_BROLL_MAX_COVERAGE) === 0) return [];
  const deps = { ...dependencies, ...overrides };
  const sequence = manualSequencePreview(options, source.duration);
  const interval = manualPreviewInterval(options, source.duration);
  const cuts = sequence?.cuts ?? (interval ? [{ start: interval.start, end: interval.end }] : undefined);
  const duration = sequence?.outputDuration ?? interval?.outputDuration;
  if (!cuts || !duration) throw new Error("Choose valid manual cuts before adding supporting visuals.");
  job.summary ??= { title: source.name, changes: [], sourceDuration: source.duration, outputDuration: duration,
    transcriptAvailable: false, usedAI: false, narration: false };
  job.summary.outputDuration = duration;
  job.notes ??= [];
  let transcript: Transcript | undefined;
  if ((source.hasAudio || audioPath) && !options.muted && options.volume > 0) {
    onPhase("Reading speech for your supporting visuals", 5);
    try {
      if (await deps.available()) {
        const onProgress = (value: number) => onPhase("Reading speech for your supporting visuals", 5 + value * 0.2);
        if (audioPath) {
          // Replacement audio loops from zero on the output clock and is not
          // sped up with the picture. Transcribe that exact interval locally.
          const soundtrack = path.join(workDir, "manual-visuals-audio.wav");
          await runLocal("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-stream_loop", "-1",
            ...MEDIA_INPUT_ARGS, "-i", audioPath, "-t", String(duration), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", soundtrack],
          { signal, timeout: 180000 });
          transcript = await deps.transcribe({ input: soundtrack, workDir, signal, onProgress });
        } else {
          const original = await deps.sourceTranscript(source, workDir, signal, onProgress);
          const edited = retimeTranscript(original, cuts);
          transcript = { ...edited, duration, segments: edited.segments.map(segment => ({ ...segment,
            start: segment.start / options.speed, end: segment.end / options.speed,
            words: segment.words.map(word => ({ ...word, start: word.start / options.speed, end: word.end / options.speed })),
          })) };
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      job.notes.push(`Speech matching was unavailable: ${error instanceof Error ? error.message : "transcription failed"}.`);
    }
  }
  signal.throwIfAborted();
  job.summary.transcriptAvailable = Boolean(transcript?.segments.length);
  if (!transcript?.segments.length) job.notes.push("No speech transcript was available for supporting visuals. Local library matching uses the source filename; speech-based stock, AI matches and explainers may be skipped.");
  return deps.prepare({ ...input, options, transcript,
    assets: input.assets.filter(asset => options.brollIds?.includes(asset.id)),
    occupied: footageTimeline(options.ownFootage, duration, options.fps === "source" ? source.fps : Number(options.fps))
      .covers.map(item => ({ start: item.at, end: item.at + item.length })),
  });
}
