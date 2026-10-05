import { rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RemixSettings } from "../shared/types.js";
import { burnOutputCaptions, probeMedia } from "./engine.js";
import { captionsSrt } from "./auto-plan.js";
import { inspectSourceCaptions } from "./source-captions.js";
import { transcriptionAvailable, transcribeLocal } from "./transcription.js";

export const wantsManualCaptions = (settings: RemixSettings) => settings.automaticCaptions === "auto" || settings.automaticCaptions === "add";

/** Listen after cuts, speed changes, replacement audio and uploaded footage have been composed. */
export async function addManualCaptions(options: {
  output: string; settings: RemixSettings; workDir: string; signal: AbortSignal;
  onPhase: (phase: string, progress: number) => void;
}, dependencies: { available?: typeof transcriptionAvailable; transcribe?: typeof transcribeLocal; inspect?: typeof inspectSourceCaptions } = {}) {
  const { output, settings, workDir, signal, onPhase } = options;
  signal.throwIfAborted();
  const media = await probeMedia(output, signal);
  if (!media.hasAudio) return { note: "Automatic captions were skipped because this export has no audio." };
  if (!await (dependencies.available || transcriptionAvailable)())
    throw new Error("Automatic captions need the local speech model. Run npm run setup:auto, then retry this export.");
  onPhase("Transcribing the finished soundtrack locally", 65);
  const transcript = await (dependencies.transcribe || transcribeLocal)({ input: output, workDir, signal,
    onProgress: progress => onPhase("Transcribing the finished soundtrack locally", 65 + progress * 0.2) });
  signal.throwIfAborted();
  if (settings.automaticCaptions !== "add") {
    onPhase("Checking for captions already in the picture", 86);
    const inspection = await (dependencies.inspect || inspectSourceCaptions)({ source: { filePath: output, size: (await stat(output)).size, duration: media.duration },
      cuts: [{ start: 0, end: media.duration }], transcript, signal });
    signal.throwIfAborted();
    if (inspection.status !== "not-detected") return { note: inspection.status === "detected"
      ? "Original captions were kept. No new captions were added."
      : "Existing captions could not be ruled out. No new captions were added; choose Automatic · add new to override.", detail: inspection.reason };
  }
  const srt = captionsSrt(transcript);
  if (!srt.trim()) return { note: "No usable speech was found in the finished soundtrack. No captions were added." };
  const subtitlePath = path.join(workDir, "manual-captions.srt");
  await writeFile(subtitlePath, srt, "utf8");
  onPhase("Adding automatic captions", 88);
  const captioned = path.join(workDir, "captioned-output.mp4");
  await burnOutputCaptions({ input: output, output: captioned, subtitlePath, style: settings.captionStyle,
    words: transcript.segments.flatMap(segment => segment.words), workDir, signal });
  signal.throwIfAborted();
  await rename(captioned, output);
  return { subtitlePath, note: "Automatic captions follow the finished soundtrack, including added clips and speed changes." };
}
