import type { AutoOptions } from '../shared/types';

export default function AutoLengthMode({ value, mixed = false, onChange }: {
  value: AutoOptions['durationMode']; mixed?: boolean; onChange: (mode: NonNullable<AutoOptions['durationMode']>) => void;
}) {
  return <fieldset className="quick-auto-group auto-length-mode">
    <legend>Video length</legend>
    <div className="quick-auto-options">
      <label className="quick-auto-option">
        <input type="radio" name="auto-length-mode" checked={!mixed && value === 'full'} onChange={() => onChange('full')} />
        <span><strong>Keep the full video</strong><small>Each video keeps its own length. Added footage adds time.</small></span>
      </label>
      <label className="quick-auto-option">
        <input type="radio" name="auto-length-mode" checked={!mixed && value !== 'full'} onChange={() => onChange('excerpt')} />
        <span><strong>Let Auto choose a shorter clip</strong><small>Choose a maximum. Auto can keep less.</small></span>
      </label>
    </div>
    {mixed && <p className="auto-preferences-note">Choose a length option to apply it to every video in the current settings scope.</p>}
  </fieldset>;
}
