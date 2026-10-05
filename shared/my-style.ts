import { z } from "zod";
import { applyAudioLook, audioLookById, AUTO_AUDIO_MODES, DEFAULT_AUDIO_SETTINGS, isAutoAudioNone } from "./audio.js";
import { applyBandFinish, blackBandFinishSchema } from "./black-bands.js";
import { CAPTION_PRESETS, captionStyleSchema, withoutHighlight, type CaptionStyle } from "./caption-style.js";
import { pacingOptionsSchema } from "./pacing.js";
import type { AutoOptions, RemixSettings } from "./types.js";

/**
 * One look for every workflow: caption appearance, black-band layout, pacing and sound. Words,
 * timing, footage and per-video text never belong to it, so applying it keeps each video's content.
 */
export const MY_STYLE_STORAGE = "remix-my-style-v1";
const styleSchema = z.object({
  version: z.literal(1),
  captionStyle: captionStyleSchema.optional(),
  blackBands: blackBandFinishSchema.optional(),
  pacing: pacingOptionsSchema.optional(),
  audio: z.enum(AUTO_AUDIO_MODES).optional(),
  savedAt: z.iso.datetime(),
}).strict();
export type MyStyle = z.infer<typeof styleSchema>;

export function captureMyStyle(options: AutoOptions, savedAt = new Date().toISOString()): MyStyle {
  const bands = options.blackBands;
  return styleSchema.parse({
    version: 1, savedAt,
    ...(options.captionStyle ? { captionStyle: structuredClone(options.captionStyle) } : {}),
    ...(bands ? { blackBands: { enabled: bands.enabled, fit: bands.fit, topPercent: bands.topPercent, bottomPercent: bands.bottomPercent, fontPercent: bands.fontPercent } } : {}),
    ...(options.pacing ? { pacing: structuredClone(options.pacing) } : {}),
    ...(options.audio ? { audio: options.audio } : {}),
  });
}
export function restoreMyStyle(value: unknown): MyStyle | null {
  const parsed = styleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Auto keeps its length, versions, visuals, captions choice and band text. */
export function styleAuto(options: AutoOptions, style: MyStyle): AutoOptions {
  return {
    ...options,
    ...(style.captionStyle ? { captionStyle: structuredClone(style.captionStyle) } : {}),
    ...(style.blackBands ? { blackBands: applyBandFinish(options.blackBands, style.blackBands) } : {}),
    ...(style.pacing ? { pacing: structuredClone(style.pacing) } : {}),
    ...(style.audio ? { audio: style.audio } : {}),
  };
}
/**
 * Manual keeps its cuts, speed, color and band text. A measured Auto sound has no Manual equivalent,
 * so only a pinned sound look or None changes Manual's sound.
 */
export function styleManual(settings: RemixSettings, style: MyStyle): RemixSettings {
  let next: RemixSettings = {
    ...settings,
    ...(style.captionStyle ? { captionStyle: structuredClone(style.captionStyle) } : {}),
    ...(style.blackBands ? { blackBands: applyBandFinish(settings.blackBands, style.blackBands) } : {}),
  };
  if (isAutoAudioNone(style.audio)) next = { ...next, ...DEFAULT_AUDIO_SETTINGS };
  else if (style.audio && style.audio !== "auto") next = applyAudioLook(next, style.audio);
  return next;
}

const sameStyle = (a: CaptionStyle, b: CaptionStyle) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const PACING_NAMES = { off: "Original pacing", natural: "Natural pacing", tight: "Tight pacing", custom: "Custom pacing" } as const;

/** A short, readable summary of what the style changes. */
export function describeMyStyle(style: MyStyle): string[] {
  const captions = style.captionStyle
    ? `${CAPTION_PRESETS.find(preset => sameStyle(preset.style, withoutHighlight(style.captionStyle!)))?.name ?? "Custom"} captions${style.captionStyle.wordHighlight ? " · word highlight" : ""}` : "Default captions";
  const bands = style.blackBands?.enabled ? `Black bands ${style.blackBands.topPercent}% / ${style.blackBands.bottomPercent}%` : "No black bands";
  const pacing = style.pacing ? PACING_NAMES[style.pacing.mode] : "Default pacing";
  const sound = !style.audio || style.audio === "auto" ? "Measured sound" : isAutoAudioNone(style.audio) ? "Original sound"
    : `${audioLookById(style.audio)?.name ?? "Custom"} sound`;
  return [captions, bands, pacing, sound];
}
