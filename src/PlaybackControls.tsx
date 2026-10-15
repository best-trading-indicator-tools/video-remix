import Slider from './Slider';
import { useEffect, useState } from 'react';
import { embeddedTextRegionsSchema, type EmbeddedTextRegion } from '../shared/embedded-text';
import type { Playback } from '../shared/playback';
import './playback.css';

function CaptionAreas({ regions, onChange }: { regions: EmbeddedTextRegion[]; onChange: (regions: EmbeddedTextRegion[]) => void }) {
  const [draft, setDraft] = useState(regions);
  const signature = JSON.stringify(regions);
  useEffect(() => { setDraft(regions); }, [signature]);
  const valid = embeddedTextRegionsSchema.safeParse(draft);
  const changed = JSON.stringify(draft) !== signature;
  return <details className="embedded-caption-areas"><summary>Caption areas · {regions.length ? `${regions.length} manual` : 'automatic'}</summary>
    <p className="field-hint">Automatic detection looks for fixed text. For missed captions, mark an area in the original, unflipped picture. Include every word and its outline. Moving or angled text is not supported.</p>
    <label>Detection<select aria-label="Caption area detection" value={regions.length ? 'manual' : 'auto'} onChange={event => onChange(event.target.value === 'auto' ? [] : [{ x: .1, y: .65, width: .8, height: .2 }])}>
      <option value="auto">Automatic</option><option value="manual">Manual areas</option>
    </select></label>
    {!!regions.length && <>
      {draft.map((region, index) => <div className="embedded-caption-region" key={index}>
        <strong>Area {index + 1}</strong>
        <div className="embedded-caption-coordinates">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>
          {{ x: 'Left', y: 'Top', width: 'Width', height: 'Height' }[key]} %
          <input aria-label={`Area ${index + 1} ${key} percent`} type="number" min={0} max={key === 'height' ? 35 : 100} step={1}
            value={Number.isFinite(region[key]) ? Number((region[key] * 100).toFixed(2)) : ""} onChange={event => setDraft(items => items.map((item, i) => i === index ? { ...item, [key]: event.target.valueAsNumber / 100 } : item))} />
        </label>)}</div>
        {draft.length > 1 && <button type="button" className="text-button" onClick={() => setDraft(items => items.filter((_, i) => i !== index))}>Remove area {index + 1}</button>}
      </div>)}
      {!valid.success && <p role="alert" className="field-hint">{valid.error.issues[0]?.message}</p>}
      <div className="embedded-caption-buttons">
        {draft.length < 4 && <button type="button" className="secondary-button" onClick={() => setDraft(items => [...items, { x: .1, y: .05 + (items.length - 1) * .15, width: .8, height: .1 }])}>Add area</button>}
        <button type="button" className="secondary-button" disabled={!changed || !valid.success} onClick={() => { if (valid.success) onChange(valid.data); }}>Apply areas</button>
        {changed && <button type="button" className="text-button" onClick={() => setDraft(regions)}>Discard area changes</button>}
      </div>
      {changed && <p className="field-hint">Apply areas before rendering a preview. Areas must fit inside the picture without overlapping.</p>}
    </>}
  </details>;
}

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
      <p className="field-hint">Mirrors the whole picture, including text already in the video. Text added in the editor stays readable.</p>
      {value.mirror && <div className="embedded-caption-controls">
        <label className="playback-flip-option"><input type="checkbox" checked={value.preserveEmbeddedText ?? false} onChange={event => onChange({ preserveEmbeddedText: event.target.checked })} />
          <span>Keep embedded captions readable</span>
        </label>
        <p className="field-hint">For fixed captions or titles already in the video. Enable to prepare a corrected five-second sample. Each area’s background also flips; check for visible edges. This cannot reliably keep an entire app screen or moving text readable.</p>
        {value.preserveEmbeddedText && <CaptionAreas regions={value.embeddedTextRegions ?? []} onChange={embeddedTextRegions => onChange({ embeddedTextRegions })} />}
      </div>}
    </fieldset>
  </>;
}
