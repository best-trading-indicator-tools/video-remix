import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  type AutoCapabilities,
  type RemixSettings,
  type RenderJob,
  type Transcript,
} from "../shared/types.js";
import { paths } from "./config.js";
import { type StoredJob, type StoredSource } from "./store.js";
import {
  transcriptionAvailable,
  transcribeLocal,
  transcriptSchema,
} from "./transcription.js";
import {
  createNarration,
  intelligenceAvailable,
  narrationAvailable,
  writeCreativePlan,
} from "./intelligence.js";
import {
  buildCandidates,
  captionsSrt,
  cutsDuration,
  fallbackHook,
  retimeTranscript,
  sceneCuts,
  selectSpeechCuts,
  alignCallouts,
} from "./auto-plan.js";
import { MEDIA_INPUT_ARGS, runLocal } from "./auto-process.js";
import { completedAutoSiblings, type EditorialPlan } from "./diversity.js";
import { graphicsAvailable } from "./visuals.js";
import { brollAIConfigured } from "./broll-ai.js";

export async function getAutoCapabilities(): Promise<AutoCapabilities> {
  const [transcription, intelligence, voice, motionGraphics] =
    await Promise.all([
      transcriptionAvailable(),
      intelligenceAvailable(),
      narrationAvailable(),
      graphicsAvailable(),
    ]);
  return {
    transcription,
    intelligence,
    narration: transcription && intelligence && voice,
    motionGraphics,
    brollAI: brollAIConfigured(),
    brollAIModel: process.env.DEEPSEEK_MODEL || "deepseek-flash",
    model: process.env.WHISPER_MODEL || "small",
    ...(!transcription
      ? {
          message:
            "Visual edits are ready. Run npm run setup:auto once to enable automatic speech captions and pause trimming.",
        }
      : !intelligence
        ? {
            message:
              "Local captions and automatic cuts are ready. Hooks use your spoken words; install Ollama with llama3.2 for rewritten hooks.",
          }
        : {}),
  };
}

async function sourceTranscript(
  source: StoredSource,
  workDir: string,
  signal: AbortSignal,
  onProgress: (value: number) => void,
): Promise<Transcript> {
  const cachePath = path.join(paths.analysis, `${source.id}.json`);
  const key = `v1:${process.env.WHISPER_MODEL || "small"}:${source.size}:${source.duration}`;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as {
      key?: string;
      transcript?: unknown;
    };
    const parsed = transcriptSchema.safeParse(cached.transcript);
    if (cached.key === key && parsed.success) {
      signal.throwIfAborted();
      onProgress(100);
      return parsed.data;
    }
  } catch {
    signal.throwIfAborted();
  }
  const transcript = await transcribeLocal({
    input: source.filePath,
    workDir,
    signal,
    onProgress,
  });
  signal.throwIfAborted();
  const temporary = path.join(workDir, `transcript-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify({ key, transcript }), {
    mode: 0o600,
  });
  await rename(temporary, cachePath);
  return transcript;
}

async function detectScenes(
  input: string,
  signal: AbortSignal,
): Promise<number[]> {
  const { stderr } = await runLocal(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-threads",
      "2",
      ...MEDIA_INPUT_ARGS,
      "-i",
      input,
      "-an",
      "-vf",
      "scale=160:-2,fps=2,select='gt(scene,0.32)',showinfo",
      "-filter_threads",
      "1",
      "-f",
      "null",
      "-",
    ],
    { signal, timeout: 180000 },
  );
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

interface PreparedAuto {
  settings: RemixSettings;
  subtitlePath?: string;
  audioPath?: string;
  summary: NonNullable<RenderJob["summary"]>;
  notes: string[];
  transcript?: Transcript;
}

export class AutoSkipError extends Error {
  override name = "AutoSkipError";
}

export async function prepareAutoRemix({
  source,
  job,
  workDir,
  signal,
  onPhase,
  previous = [],
}: {
  source: StoredSource;
  job: StoredJob;
  workDir: string;
  signal: AbortSignal;
  onPhase: (phase: string, progress: number) => void;
  previous?: RenderJob[];
}): Promise<PreparedAuto> {
  const options = job.auto!;
  const notes: string[] = [];
  const changes: string[] = [];
  const variant = job.variant - 1;
  const siblings = completedAutoSiblings(job, previous);
  signal.throwIfAborted();
  if (source.duration <= options.targetDuration && siblings.length)
    throw new AutoSkipError(
      "This short video already has a finished edit in this batch. Another version would repeat the same footage.",
    );
  let transcript: Transcript | undefined;
  onPhase("Checking your footage", 2);
  if (source.hasAudio) {
    if (await transcriptionAvailable()) {
      try {
        onPhase("Transcribing speech", 5);
        transcript = await sourceTranscript(source, workDir, signal, (value) =>
          onPhase("Transcribing speech", 5 + value * 0.3),
        );
      } catch {
        signal.throwIfAborted();
        notes.push(
          "Speech recognition did not finish. This version uses visual editing and preserves the source audio.",
        );
      }
    } else
      notes.push(
        "The local speech model is not installed. This version uses visual editing; automatic captions become available after setup.",
      );
  }
  signal.throwIfAborted();
  const previousPlans: EditorialPlan[] = siblings.map((sibling) => {
    const cuts = sibling.settings.segments || [
      {
        start: sibling.settings.trimStart,
        end: sibling.settings.trimEnd ?? source.duration,
      },
    ];
    return {
      cuts,
      text: transcript
        ? retimeTranscript(transcript, cuts)
            .segments.map((segment) => segment.text)
            .join(" ")
        : undefined,
    };
  });
  const candidates = transcript
    ? buildCandidates(
        transcript,
        source.duration,
        options.targetDuration,
        variant,
        previousPlans,
      )
    : [];
  if (
    transcript &&
    previousPlans.length &&
    !candidates.length &&
    buildCandidates(
      transcript,
      source.duration,
      options.targetDuration,
      variant,
    ).length
  )
    throw new AutoSkipError(
      "The remaining spoken excerpts repeat edits already finished in this batch. No additional version was created.",
    );
  let cuts: RemixSettings["segments"];
  let captionTranscript: Transcript | undefined;
  let hook = "";
  let callouts: string[] = [];
  let usedAI = false;
  let narrated = false;
  let audioPath: string | undefined;
  if (transcript && candidates.length) {
    onPhase("Choosing a cut and writing its hook", 38);
    const creative = await writeCreativePlan(
      candidates,
      job.variant,
      transcript.language,
      options.narration,
      signal,
    );
    const candidate = candidates[creative?.windowIndex ?? 0]!;
    cuts = selectSpeechCuts(transcript, candidate);
    captionTranscript = retimeTranscript(transcript, cuts);
    hook = creative?.hook || fallbackHook(captionTranscript);
    callouts = creative?.callouts || [];
    usedAI = !!creative;
    if (source.duration > options.targetDuration)
      changes.push("Selected a spoken excerpt");
    const removedPauses = candidate.end - candidate.start - cutsDuration(cuts);
    if (removedPauses > 0.3)
      changes.push(`Trimmed ${removedPauses.toFixed(1)}s of pauses`);
    if (!creative)
      notes.push(
        "The hook was taken from the selected speech. Local AI rewriting was unavailable for this version.",
      );
    if (options.narration) {
      if (creative?.narration.trim() && (await narrationAvailable())) {
        try {
          onPhase("Recording new narration", 46);
          const voice = await createNarration(
            creative.narration,
            transcript.language,
            cutsDuration(cuts),
            workDir,
            signal,
          );
          onPhase("Timing narration captions", 50);
          const voiceTranscript = await transcribeLocal({
            input: voice.path,
            workDir,
            signal,
            onProgress: (value) =>
              onPhase("Timing narration captions", 50 + value * 0.1),
          });
          if (!voiceTranscript.segments.length)
            throw new Error("No timed narration was recognized.");
          captionTranscript = voiceTranscript;
          audioPath = voice.path;
          let remaining = voice.duration;
          cuts = cuts.flatMap((cut) => {
            const length = Math.min(cut.end - cut.start, remaining);
            remaining -= length;
            return length >= 0.04
              ? [{ start: cut.start, end: cut.start + length }]
              : [];
          });
          narrated = true;
          changes.push("New narration");
        } catch {
          signal.throwIfAborted();
          notes.push(
            "New narration could not be completed for this clip. Its original speech and captions were kept.",
          );
        }
      } else
        notes.push(
          "A rewritten narration was not available for this clip. Original audio was kept; narration needs recognized speech, a local AI model, and a matching installed voice.",
        );
    }
  } else {
    onPhase("Finding visual cuts", 38);
    let scenes: number[] = [];
    try {
      scenes = await detectScenes(source.filePath, signal);
    } catch {
      signal.throwIfAborted();
      notes.push(
        "Scene analysis was unavailable; a continuous excerpt was used.",
      );
    }
    cuts = sceneCuts(
      scenes,
      source.duration,
      options.targetDuration,
      variant,
      previousPlans,
    );
    if (!cuts.length && previousPlans.length)
      throw new AutoSkipError(
        "The available scene edits repeat footage already used in this batch. No additional version was created.",
      );
    if (source.duration > options.targetDuration)
      changes.push(
        scenes.length
          ? "Selected scene excerpts"
          : "Selected a shorter excerpt",
      );
    notes.push(
      "No usable spoken excerpt was found. This version has no generated speech captions or hook.",
    );
    if (options.narration)
      notes.push(
        "Narration was skipped because there was no reliable spoken source to rewrite.",
      );
  }
  signal.throwIfAborted();
  if (!cuts?.length)
    throw new Error("This video did not contain a usable section to edit.");
  const duration = cutsDuration(cuts);
  const targetRatio =
    options.aspect === "original"
      ? source.width / source.height
      : Number(options.aspect.split(":")[0]) /
        Number(options.aspect.split(":")[1]);
  const blur = Math.abs(source.width / source.height - targetRatio) > 0.12;
  const settings: RemixSettings = {
    ...DEFAULT_SETTINGS,
    aspect: options.aspect,
    fit: blur ? "blur" : "crop",
    resolution: "1080",
    fps: "30",
    segments: cuts,
    hookText: hook,
    hookDuration: Math.min(3.5, duration),
    normalizeAudio: true,
    autoMotion: false,
    device: "none",
    callouts: captionTranscript
      ? alignCallouts(callouts, captionTranscript, duration)
      : [],
  };
  if (hook) changes.push(usedAI ? "Rewritten hook" : "Spoken hook");
  if (settings.callouts?.length) changes.push("Key-point overlays");
  let subtitlePath: string | undefined;
  if (captionTranscript) {
    onPhase("Adding timed captions", 61);
    const srt = captionsSrt(captionTranscript);
    if (srt.trim()) {
      subtitlePath = path.join(workDir, "auto-captions.srt");
      await writeFile(subtitlePath, srt, "utf8");
      changes.push("Automatic captions");
    }
  }
  changes.push(
    `${options.aspect === "original" ? "Original format" : options.aspect} export`,
  );
  changes.push(
    blur
      ? "Blurred background"
      : Math.abs(source.width / source.height - targetRatio) < 0.001
        ? "Original framing"
        : "Reframed",
  );
  if (source.hasAudio || audioPath) changes.push("Balanced audio");
  onPhase("Rendering your edit", 65);
  return {
    settings,
    subtitlePath,
    audioPath,
    notes,
    transcript: captionTranscript,
    summary: {
      title: hook || `${path.parse(source.name).name} — cut ${job.variant}`,
      changes,
      sourceDuration: source.duration,
      outputDuration: duration,
      transcriptAvailable: !!captionTranscript?.segments.length,
      usedAI,
      narration: narrated,
    },
  };
}
