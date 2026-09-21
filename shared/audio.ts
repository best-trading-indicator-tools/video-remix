import type { RemixSettings } from "./types.js";

// Sound looks own only tone, noise and dynamics. They must not replace volume,
// mute, loudness normalization, replacement audio, framing, timing or captions.
export const AUDIO_LOOK_KEYS = [
  "denoise", "lowCut", "bass", "presence", "treble", "compression", "deEss",
] as const;
export type AudioLookKey = (typeof AUDIO_LOOK_KEYS)[number];
export type AudioAdjustments = Record<AudioLookKey, number>;

/** Inclusive bounds, shared by the editor, the request schema and the renderer. */
export const AUDIO_RANGES: Record<AudioLookKey, readonly [number, number]> = {
  denoise: [0, 1], lowCut: [0, 1], bass: [-1, 1], presence: [-1, 1],
  treble: [-1, 1], compression: [0, 1], deEss: [0, 1],
};
export const MAX_AUDIO_FADE = 5;

export const AUDIO_LOOK_IDS = [
  "original", "clear", "podcast", "warm", "bright", "cleanup", "smooth", "phone",
] as const;
export type AudioLookId = (typeof AUDIO_LOOK_IDS)[number];
/** Auto either measures and chooses ("auto"), leaves the sound alone, or is pinned to one look. */
export const AUTO_AUDIO_MODES = ["auto", "off", ...AUDIO_LOOK_IDS] as const;
export type AutoAudioMode = (typeof AUTO_AUDIO_MODES)[number];
/** Both saved neutral choices mean None in Auto; Manual sound looks stay separate. */
export const isAutoAudioNone = (mode?: AutoAudioMode): boolean => mode === "off" || mode === "original";

export const NEUTRAL_AUDIO: AudioAdjustments = {
  denoise: 0, lowCut: 0, bass: 0, presence: 0, treble: 0, compression: 0, deEss: 0,
};
export const DEFAULT_AUDIO_SETTINGS = { ...NEUTRAL_AUDIO, fadeIn: 0, fadeOut: 0 };

export interface AudioLook {
  id: AudioLookId;
  name: string;
  description: string;
  /** Creative treatments are offered in the editor but never chosen automatically. */
  automatic: boolean;
  adjustments: AudioAdjustments;
}

const look = (
  id: AudioLookId, name: string, description: string,
  adjustments: Partial<AudioAdjustments> = {}, automatic = true,
): AudioLook => ({ id, name, description, automatic, adjustments: { ...NEUTRAL_AUDIO, ...adjustments } });

export const AUDIO_LOOKS: readonly AudioLook[] = [
  look("original", "Original", "Untouched tone, noise and dynamics."),
  look("clear", "Clear voice", "Removes rumble and lifts speech out of the room.",
    { denoise: 0.3, lowCut: 0.6, presence: 0.3, treble: 0.1, compression: 0.4, deEss: 0.3 }),
  look("podcast", "Podcast", "Evens out loud and quiet delivery.",
    { denoise: 0.15, lowCut: 0.4, bass: 0.1, presence: 0.15, treble: 0.05, compression: 0.55, deEss: 0.25 }),
  look("warm", "Warm", "Fuller low end with a softer top.",
    { denoise: 0.1, lowCut: 0.35, bass: 0.3, presence: -0.05, treble: -0.2, compression: 0.3, deEss: 0.2 }),
  look("bright", "Bright", "Opens up a dull or distant recording.",
    { denoise: 0.15, lowCut: 0.45, bass: -0.05, presence: 0.4, treble: 0.45, compression: 0.35, deEss: 0.4 }),
  look("cleanup", "Noisy room", "Strong hiss, hum and rumble reduction.",
    { denoise: 0.75, lowCut: 0.7, presence: 0.25, treble: -0.1, compression: 0.35, deEss: 0.25 }),
  look("smooth", "Smooth", "Tames harsh, sibilant or thin microphones.",
    { denoise: 0.2, lowCut: 0.4, bass: 0.1, presence: -0.15, treble: -0.45, compression: 0.3, deEss: 0.65 }),
  look("phone", "Phone call", "Deliberate narrow-band radio effect.",
    { denoise: 0.3, lowCut: 1, bass: -0.8, presence: 0.7, treble: -0.8, compression: 0.8, deEss: 0.2 }, false),
];

export function clampAudio(key: AudioLookKey, value: number): number {
  const [low, high] = AUDIO_RANGES[key];
  return Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : NEUTRAL_AUDIO[key];
}

/** Edits saved before sound looks carry no audio fields; read those as neutral. */
export function audioAdjustments(settings: Partial<AudioAdjustments>): AudioAdjustments {
  return Object.fromEntries(AUDIO_LOOK_KEYS.map(key =>
    [key, clampAudio(key, settings[key] ?? NEUTRAL_AUDIO[key])])) as AudioAdjustments;
}

export const audioLookById = (id: string): AudioLook | undefined =>
  AUDIO_LOOKS.find(item => item.id === id);

export function applyAudioLook(settings: RemixSettings, id: string): RemixSettings {
  const selected = audioLookById(id);
  return selected ? { ...settings, ...selected.adjustments } : settings;
}

export function activeAudioLook(settings: RemixSettings): string | null {
  const current = audioAdjustments(settings);
  return AUDIO_LOOKS.find(item => AUDIO_LOOK_KEYS.every(key =>
    Math.abs(current[key] - item.adjustments[key]) < 1e-9))?.id ?? null;
}

/** A five-band silhouette of the treatment, as bar heights between 0 and 1. */
export function audioLookBars(adjustments: AudioAdjustments): number[] {
  const level = (value: number) => Math.max(0.08, Math.min(1, 0.5 + value / 2));
  return [
    level(adjustments.bass - adjustments.lowCut),
    level(adjustments.bass),
    level(adjustments.presence),
    level(adjustments.treble),
    level(adjustments.treble - adjustments.deEss),
  ];
}

/**
 * Levels measured from the selected footage, in dBFS. Window levels come from
 * half-second RMS samples; band levels are stated relative to the full-band
 * mean so the same thresholds hold at any recording level.
 */
export interface AudioAnalysis {
  /** 5th, 50th and 95th percentile of the half-second window levels. */
  quietDb: number;
  medianDb: number;
  loudDb: number;
  /** Below 200 Hz, 200–1200 Hz, 1200–4000 Hz and above 5000 Hz. */
  lowDb: number;
  bodyDb: number;
  presenceDb: number;
  airDb: number;
}

/**
 * Turn a measurement into the treatment it asks for. Thresholds are anchored on
 * measured references: clean speech sits near low −15 dB, presence − body
 * +1 dB, air − presence −7 dB, and roughly 26 dB between its quiet and loud
 * windows. Every response stops well short of its maximum, because an automatic
 * choice should be audibly safe rather than maximally corrective.
 */
export function audioTargets(analysis: AudioAnalysis): AudioAdjustments {
  const clamp = (value: number, low: number, high: number) =>
    Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : 0;
  const signalToNoise = analysis.loudDb - analysis.quietDb;
  const spread = analysis.loudDb - analysis.medianDb;
  const presenceBalance = analysis.presenceDb - analysis.bodyDb;
  const airBalance = analysis.airDb - analysis.presenceDb;
  const lowCut = clamp((analysis.lowDb + 12) / 10, 0, 1);
  // A loud continuous floor can be rumble rather than hiss. Spectral denoising
  // cannot fix rumble, and running it at full strength there costs detail.
  const denoise = clamp((26 - signalToNoise) / 18, 0, 0.8) * (1 - 0.75 * lowCut);
  return {
    denoise,
    lowCut,
    bass: clamp((-20 - analysis.lowDb) / 12, 0, 0.35),
    presence: clamp((1 - presenceBalance) / 6, -0.3, 0.5),
    treble: clamp((-7 - airBalance) / 9, -0.5, 0.5),
    compression: clamp((spread - 8) / 10, 0, 0.6),
    deEss: clamp((airBalance + 2) / 7, 0, 0.7),
  };
}

/**
 * Cost of using a look for a measured target. The weights are asymmetric
 * because the two directions are not equally audible: missing denoising leaves
 * the noise in, over-denoising adds artefacts, and a high-pass that was not
 * needed is close to inaudible on speech.
 */
const SELECTION_WEIGHTS: Record<AudioLookKey, { under: number; over: number }> = {
  denoise: { under: 3, over: 2 },
  lowCut: { under: 1, over: 0.25 },
  bass: { under: 1, over: 1 },
  presence: { under: 1.2, over: 1.2 },
  treble: { under: 1, over: 1.2 },
  compression: { under: 2, over: 1.2 },
  deEss: { under: 1, over: 1 },
};

export function audioLookCost(look: AudioLook, targets: AudioAdjustments): number {
  return AUDIO_LOOK_KEYS.reduce((total, key) => {
    const difference = look.adjustments[key] - targets[key];
    const weight = SELECTION_WEIGHTS[key][difference < 0 ? "under" : "over"];
    return total + weight * difference * difference;
  }, 0);
}

const FINDINGS: { key: AudioLookKey; least: number; text: string }[] = [
  { key: "denoise", least: 0.3, text: "a noticeable background noise floor" },
  { key: "lowCut", least: 0.5, text: "low-frequency rumble under the speech" },
  { key: "deEss", least: 0.35, text: "harsh sibilance" },
  { key: "treble", least: 0.3, text: "a dull, closed-in top end" },
  { key: "presence", least: 0.3, text: "speech sitting behind the rest of the sound" },
  { key: "compression", least: 0.3, text: "an uneven level between loud and quiet delivery" },
  { key: "bass", least: 0.2, text: "a thin low end" },
];

/** Choose the named look that best answers the measurement, and say why. */
export function chooseAudioLook(analysis: AudioAnalysis): { id: AudioLookId; name: string; reason: string } {
  const targets = audioTargets(analysis);
  const choice = AUDIO_LOOKS.filter(item => item.automatic)
    .reduce((best, item) => audioLookCost(item, targets) < audioLookCost(best, targets) ? item : best);
  const found = FINDINGS.filter(finding => targets[finding.key] >= finding.least).slice(0, 2);
  return {
    id: choice.id,
    name: choice.name,
    reason: choice.id === "original"
      ? "the sound measured clean and even already"
      : found.length ? found.map(finding => finding.text).join(" and ")
        : "the measured tone balance",
  };
}
