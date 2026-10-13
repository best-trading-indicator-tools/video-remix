import Slider from './Slider';
import type { Playback } from '../shared/playback';
import './playback.css';

export default function PlaybackControls({ value, onChange, disabled = false }: {
  value: Playback; onChange: (patch: Playback) => void; disabled?: boolean;
}) {
  return <>
    <fieldset className="playback-section" disabled={disabled}>
      <legend>Video speed</legend>
      <Slider label="Playback speed" value={value.speed ?? 1} defaultValue={1} min={0.5} max={2} unit="×"
        onChange={speed => onChange({ speed })} disabled={disabled}
        hint="0.5× slower · 1× normal · 2× faster. Audio follows the video; added clips keep their speed." />
    </fieldset>
    <fieldset className="playback-section" disabled={disabled}>
      <legend>Horizontal flip</legend>
      <label className="playback-flip-option"><input type="checkbox" checked={value.mirror ?? false} onChange={event => onChange({ mirror: event.target.checked })} />
        <span>Flip horizontally</span>
      </label>
      <p className="field-hint">Mirror the source picture. Added text stays readable.</p>
    </fieldset>
  </>;
}
