import {
  AUDIO_LOOKS,
  AUDIO_LOOK_KEYS,
  AUDIO_RANGES,
  MAX_AUDIO_FADE,
  activeAudioLook,
  applyAudioLook,
  audioAdjustments,
  audioLookBars,
  type AudioLookKey,
} from "../shared/audio";
import type { RemixSettings } from "../shared/types";
import Slider from "./Slider";

const MODIFIERS: Record<AudioLookKey, { label: string; hint: string }> = {
  denoise: { label: "Noise reduction", hint: "Reduce steady hiss, hum and room noise." },
  lowCut: { label: "Low cut", hint: "Remove rumble, handling noise and desk thumps." },
  bass: { label: "Bass", hint: "Weight below roughly 200 Hz." },
  presence: { label: "Presence", hint: "How far forward speech sits, around 3 kHz." },
  treble: { label: "Treble", hint: "Air and detail above roughly 6 kHz." },
  compression: { label: "Even out level", hint: "Bring quiet and loud delivery closer together." },
  deEss: { label: "De-ess", hint: "Soften sharp s and t sounds." },
};

/**
 * Sound looks are the audio counterpart of the color looks: one click sets the
 * whole group, and the sliders below stay available for a look that is nearly
 * right. Volume, mute and loudness normalization are deliberately not part of a
 * look, so switching looks never changes how loud the export is.
 */
export default function SoundModifiers({ settings, onReplace, onChange, disabled = false }: {
  settings: RemixSettings;
  onReplace: (settings: RemixSettings) => void;
  onChange: (patch: Partial<RemixSettings>) => void;
  disabled?: boolean;
}) {
  const audio = audioAdjustments(settings);
  const selected = activeAudioLook(settings);
  return (
    <div className="sound-looks">
      <div className="look-grid">
        {AUDIO_LOOKS.map((look) => (
          <button
            key={look.id}
            type="button"
            className={`look-button ${selected === look.id ? "active" : ""}`}
            aria-pressed={selected === look.id}
            title={look.description}
            disabled={disabled}
            onClick={() => onReplace(applyAudioLook(settings, look.id))}
          >
            <span className="sound-swatch" aria-hidden="true">
              {audioLookBars(look.adjustments).map((height, index) => (
                <span key={index} style={{ height: `${Math.round(height * 100)}%` }} />
              ))}
            </span>
            <span>{look.name}</span>
          </button>
        ))}
      </div>
      <p className="field-hint">
        Sound looks change tone, noise and dynamics only. Your framing, timing, volume and captions stay as they are.
      </p>
      <details className="manual-subsection">
        <summary>Sound modifiers</summary>
        <p className="field-hint">
          Fine-tune the selected look. Rendered samples and exports include these; the live preview does not.
        </p>
        <fieldset disabled={disabled}>
          <legend className="visually-hidden">Sound modifiers</legend>
          {AUDIO_LOOK_KEYS.map((key) => (
            <Slider
              key={key}
              label={MODIFIERS[key].label}
              hint={MODIFIERS[key].hint}
              value={audio[key]}
              defaultValue={0}
              min={AUDIO_RANGES[key][0]}
              max={AUDIO_RANGES[key][1]}
              onChange={(value) => onChange({ [key]: value } as Partial<RemixSettings>)}
            />
          ))}
          <Slider
            label="Fade in"
            hint="Silence to full level at the start of the export."
            value={settings.fadeIn ?? 0}
            defaultValue={0}
            min={0}
            max={MAX_AUDIO_FADE}
            step={0.1}
            unit="s"
            onChange={(fadeIn) => onChange({ fadeIn })}
          />
          <Slider
            label="Fade out"
            hint="Full level to silence at the end of the export."
            value={settings.fadeOut ?? 0}
            defaultValue={0}
            min={0}
            max={MAX_AUDIO_FADE}
            step={0.1}
            unit="s"
            onChange={(fadeOut) => onChange({ fadeOut })}
          />
        </fieldset>
      </details>
    </div>
  );
}
