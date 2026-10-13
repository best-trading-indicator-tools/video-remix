import { z } from 'zod';
import type { EditPlan, Transcript } from './types.js';

export const speedSchema = z.number().finite().min(0.5).max(2)
  .describe('Video playback speed: 0.5 to 2; 1 is normal. Original audio follows speed with preserved pitch.');
export const mirrorSchema = z.boolean().describe('Flip the source picture horizontally. Added text stays readable.');
export const playbackShape = { speed: speedSchema.optional(), mirror: mirrorSchema.optional() };
export type Playback = { speed?: number; mirror?: boolean };
export const playbackSettings = (value: Playback) => ({ speed: value.speed ?? 1, mirror: value.mirror ?? false });
export function playbackSummary(before: Playback, after: Playback): string[] {
  return [
    ...((before.speed ?? 1) !== (after.speed ?? 1) ? [`Playback speed: ${after.speed ?? 1}×.`] : []),
    ...((before.mirror ?? false) !== (after.mirror ?? false) ? [`Flip horizontally: ${after.mirror ? 'on' : 'off'}.`] : []),
  ];
}
export const playbackInstructions = 'speed: 0.5–2 (1 normal, 0.5 half speed, 2 double speed); mirror: boolean (flip horizontally, true to flip, false to restore). Speed changes source playback and its audio with preserved pitch, not source trim timestamps. Added footage and replacement music keep their own playback speed. Added text remains readable when flipping. Unspecified speed and mirror mean 1 and false. Only change requested fields.';
export function transcriptAtSpeed(transcript: Transcript, speed: number): Transcript {
  return { ...transcript, duration: transcript.duration / speed, segments: transcript.segments.map(segment => ({
    ...segment, start: segment.start / speed, end: segment.end / speed,
    words: segment.words.map(word => ({ ...word, start: word.start / speed, end: word.end / speed })),
  })) };
}

/** Saved speech and supporting shots stay aligned; explicit output-clock text/footage stays fixed. */
export function retimePlanPlayback(plan: EditPlan, speed: number): EditPlan {
  speedSchema.parse(speed);
  if (speed === plan.settings.speed) return structuredClone(plan);
  const ratio = plan.settings.speed / speed;
  const retime = <T extends { start: number; end: number }>(item: T): T => ({ ...item, start: item.start * ratio, end: item.end * ratio });
  return { ...structuredClone(plan), outputDuration: plan.outputDuration * ratio,
    settings: { ...structuredClone(plan.settings), speed,
      hookDuration: Math.max(0.5, Math.min(30, plan.settings.hookDuration * ratio)),
      callouts: plan.settings.callouts?.map(retime) },
    captions: plan.captions.map(retime), captionWords: plan.captionWords?.map(retime),
    visuals: plan.visuals.map(visual => ({ ...retime(visual), playbackSpeed: (visual.playbackSpeed ?? 1) / ratio })),
  };
}
