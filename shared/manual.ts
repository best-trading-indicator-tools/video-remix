import { DEFAULT_SETTINGS, type FocalPoint, type RemixSettings } from "./types.js";

// Looks own only color and texture. They must not replace framing, timing,
// captions, sound, or either temporal frame-blending effect in an existing edit.
export const COLOR_LOOK_KEYS = [
  "saturation", "brightness", "contrast", "hue", "gamma", "temperature",
  "noise", "sharpness",
] as const;
type ColorLookKey = (typeof COLOR_LOOK_KEYS)[number];
type ColorAdjustments = Pick<RemixSettings, ColorLookKey>;
export interface ManualLook {
  id: string;
  name: string;
  description: string;
  swatch: string;
  adjustments: ColorAdjustments;
}

const neutral: ColorAdjustments = {
  saturation: DEFAULT_SETTINGS.saturation,
  brightness: DEFAULT_SETTINGS.brightness,
  contrast: DEFAULT_SETTINGS.contrast,
  hue: DEFAULT_SETTINGS.hue,
  gamma: DEFAULT_SETTINGS.gamma,
  temperature: DEFAULT_SETTINGS.temperature,
  noise: DEFAULT_SETTINGS.noise,
  sharpness: DEFAULT_SETTINGS.sharpness,
};
const look = (
  id: string, name: string, description: string, swatch: string,
  adjustments: Partial<ColorAdjustments> = {},
): ManualLook => ({ id, name, description, swatch, adjustments: { ...neutral, ...adjustments } });

export const MANUAL_LOOKS: readonly ManualLook[] = [
  look("neutral", "Neutral", "Original color and texture.",
    "linear-gradient(135deg, #a5b2bc, #e4dcd0)"),
  look("clean", "Clean", "Crisp detail with a little more contrast.",
    "linear-gradient(135deg, #456f74, #deece2)",
    { contrast: 1.06, saturation: 1.05, sharpness: 0.45 }),
  look("warm", "Warm", "Soft amber tones and restrained color.",
    "linear-gradient(135deg, #9a6545, #efd2a5)",
    { temperature: 0.15, contrast: 1.04, saturation: 0.94, brightness: 0.01 }),
  look("cool", "Cool", "Cooler tones with clear, quiet detail.",
    "linear-gradient(135deg, #3d647f, #bdced7)",
    { temperature: -0.16, contrast: 1.05, saturation: 0.96, sharpness: 0.2 }),
  look("muted", "Muted", "Gentle contrast and understated color.",
    "linear-gradient(135deg, #77786b, #bcb5a5)",
    { saturation: 0.76, contrast: 0.96, gamma: 1.04, temperature: 0.04 }),
  look("monochrome", "Monochrome", "Black and white with defined detail.",
    "linear-gradient(135deg, #333b43, #dbe0e3)",
    { saturation: 0, contrast: 1.12, gamma: 1.03, sharpness: 0.25 }),
  look("film", "Film", "Subtle grain, warmth and softer contrast.",
    "linear-gradient(135deg, #77735b, #ccaa87)",
    { saturation: 0.88, contrast: 0.97, gamma: 1.06, temperature: 0.08, noise: 0.08 }),
  look("vivid", "Vivid", "Richer color and punchier detail.",
    "linear-gradient(135deg, #287a78, #d89465)",
    { saturation: 1.22, contrast: 1.1, brightness: 0.01, sharpness: 0.3 }),
];

export function applyColorLook(settings: RemixSettings, id: string): RemixSettings {
  const selected = MANUAL_LOOKS.find((item) => item.id === id);
  return selected ? { ...settings, ...selected.adjustments } : settings;
}

export function activeColorLook(settings: RemixSettings): string | null {
  return MANUAL_LOOKS.find((item) => COLOR_LOOK_KEYS.every((key) =>
    Math.abs(settings[key] - item.adjustments[key]) < 1e-9,
  ))?.id ?? null;
}

function decimalPlaces(value: number): number {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  return Math.max(0, (coefficient.split(".")[1]?.length ?? 0) - Number(exponent));
}

// Commit a typed value on blur/Enter, preserving the previous setting while a
// field is empty or invalid. Steps are anchored at min, like an HTML range.
export function coerceManualNumber(
  input: string, fallback: number, min: number, max: number, step = 0.01,
): number {
  if (!input.trim() || ![min, max, step].every(Number.isFinite) || max < min || step <= 0)
    return fallback;
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.max(min, Math.min(max, value));
  const stepped = min + Math.round((clamped - min) / step + 1e-9) * step;
  const digits = Math.min(12, Math.max(decimalPlaces(step), decimalPlaces(min), decimalPlaces(max)));
  return Number(Math.max(min, Math.min(max, stepped)).toFixed(digits));
}

export interface ManualPreviewInterval {
  start: number;
  end: number;
  /** Length of the selected source window, before playback speed. */
  sourceDuration: number;
  outputDuration: number;
}

// The engine moves the complete trim window within the source, preserving its
// length. Full-source selections therefore cannot move. A single interval
// cannot describe the discontinuous cuts of a saved Auto plan.
export function manualPreviewInterval(
  settings: RemixSettings, sourceDuration: number,
): ManualPreviewInterval | null {
  if (
    settings.segments || !Number.isFinite(sourceDuration) || sourceDuration <= 0 ||
    !Number.isFinite(settings.trimStart) || settings.trimStart < 0 ||
    (settings.trimEnd !== null && !Number.isFinite(settings.trimEnd)) ||
    !Number.isFinite(settings.timeShift) || !Number.isFinite(settings.speed) || settings.speed <= 0
  ) return null;
  const sourceEnd = Math.min(settings.trimEnd ?? sourceDuration, sourceDuration);
  const clipLength = sourceEnd - settings.trimStart;
  if (!Number.isFinite(clipLength) || clipLength <= 0.04) return null;
  const start = Math.max(0, Math.min(sourceDuration - clipLength, settings.trimStart + settings.timeShift));
  return { start, end: start + clipLength, sourceDuration: clipLength, outputDuration: clipLength / settings.speed };
}

/** Validate the complete sequence; Live shows its first cut, rendered samples join the cuts. */
export function manualSequencePreview(settings: RemixSettings, sourceDuration: number): {
  cuts: NonNullable<RemixSettings["segments"]>;
  first: ManualPreviewInterval;
  outputDuration: number;
} | null {
  const cuts = settings.segments;
  if (!cuts?.length || cuts.length > 60 || !Number.isFinite(sourceDuration) || sourceDuration <= 0 ||
    !Number.isFinite(settings.speed) || settings.speed <= 0 || cuts.some(cut =>
      !Number.isFinite(cut.start) || !Number.isFinite(cut.end) || cut.start < 0 ||
      cut.end <= cut.start + 0.04 || cut.end > sourceDuration + 0.001)) return null;
  const first = cuts[0]!;
  const length = first.end - first.start;
  return {
    cuts,
    first: { start: first.start, end: first.end, sourceDuration: length, outputDuration: length / settings.speed },
    outputDuration: cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) / settings.speed,
  };
}

// CSS object-position percentages describe the available crop travel, whereas
// a focal point describes a position in the whole source. Translate between the
// two so portrait crops retain the requested subject and stop at source edges.
export function manualCropPosition(
  width: number, height: number, outputAspect: number, point: FocalPoint,
): string {
  if (![width, height, outputAspect].every((value) => Number.isFinite(value) && value > 0))
    return "50% 50%";
  const cropWidth = Math.min(width, height * outputAspect);
  const cropHeight = Math.min(height, width / outputAspect);
  const percent = (dimension: number, retained: number, focal: number) => {
    if (dimension - retained < 0.01 || !Number.isFinite(focal)) return 50;
    return Math.min(1, Math.max(0, (dimension * focal - retained / 2) / (dimension - retained))) * 100;
  };
  return `${percent(width, cropWidth, point.x)}% ${percent(height, cropHeight, point.y)}%`;
}
