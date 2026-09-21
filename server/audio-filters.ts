import { audioAdjustments, MAX_AUDIO_FADE, type AudioAdjustments } from "../shared/audio.js";
import type { RemixSettings } from "../shared/types.js";

const decimal = (value: number) => Number(value.toFixed(6)).toString();

/**
 * Translate the sound look into FFmpeg filters, in the order a mix is normally
 * built: clear the rumble, reduce the noise floor, shape the tone, tame what the
 * tone shaping brought forward, then even out the level. Every filter is left
 * out entirely at its neutral value so an untouched edit encodes exactly as
 * before. The chain runs before loudness normalization so the measured loudness
 * is that of the treated sound.
 */
export function audioModifierFilters(settings: Partial<AudioAdjustments>): string[] {
  const audio = audioAdjustments(settings);
  const filters: string[] = [];
  if (audio.lowCut > 0)
    filters.push(`highpass=f=${decimal(40 + 100 * audio.lowCut)}:poles=2`);
  // Tracked noise estimation follows a floor that changes between takes.
  if (audio.denoise > 0)
    filters.push(`afftdn=nr=${decimal(6 + 18 * audio.denoise)}:nf=-40:tn=1`);
  if (audio.bass !== 0)
    filters.push(`bass=g=${decimal(8 * audio.bass)}:f=110:width_type=q:w=0.7`);
  if (audio.presence !== 0)
    filters.push(`equalizer=f=2800:width_type=q:w=1.2:g=${decimal(6 * audio.presence)}`);
  if (audio.treble !== 0)
    filters.push(`treble=g=${decimal(7 * audio.treble)}:f=6500:width_type=q:w=0.6`);
  if (audio.deEss > 0)
    filters.push(`deesser=i=${decimal(0.9 * audio.deEss)}:m=0.5:f=0.5`);
  if (audio.compression > 0)
    filters.push(
      `acompressor=threshold=${decimal(10 ** ((-6 - 16 * audio.compression) / 20))}` +
      `:ratio=${decimal(1 + 4 * audio.compression)}:attack=12:release=220` +
      `:makeup=${decimal(1 + 0.4 * audio.compression)}`,
    );
  return filters;
}

const fade = (value: number | undefined, duration: number) =>
  Math.max(0, Math.min(MAX_AUDIO_FADE, duration / 2, Number.isFinite(value) ? value! : 0));

/**
 * Fades describe the finished soundtrack, so they are applied last, against the
 * exported duration. Each is capped at half the export so a fade in and a fade
 * out cannot overlap into silence.
 */
export function audioFadeFilters(settings: RemixSettings, duration: number): string[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const filters: string[] = [];
  const fadeIn = fade(settings.fadeIn, duration);
  const fadeOut = fade(settings.fadeOut, duration);
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${decimal(fadeIn)}`);
  if (fadeOut > 0)
    filters.push(`afade=t=out:st=${decimal(duration - fadeOut)}:d=${decimal(fadeOut)}`);
  return filters;
}
