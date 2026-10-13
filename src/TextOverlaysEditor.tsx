import { useEffect, useState } from "react";
import { Plus, Trash2, Type } from "lucide-react";
import CaptionStyleEditor, { NumberControl } from "./CaptionStyleEditor";
import { MAX_TEXT_OVERLAYS, TITLE_DESIGNS, titleOverlay, newTextOverlay, type TextOverlay } from "../shared/text-overlays";
import { CAPTION_FONTS } from '../shared/caption-style';
import "./text-overlays.css";

function TimeField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (value: number) => void }) {
  const [input, setInput] = useState(String(value));
  useEffect(() => setInput(String(Number(value.toFixed(3)))), [value]);
  const commit = () => {
    const number = Number(input);
    const next = input.trim() && Number.isFinite(number) ? Math.min(86400, Math.max(min, number)) : value;
    onChange(next); setInput(String(next));
  };
  return <label>{label} (s)<input type="number" aria-label={label} min={min} max={86400} step="any" value={input}
    onChange={event => { setInput(event.target.value); const number = event.target.valueAsNumber; if (Number.isFinite(number) && number >= min && number <= 86400) onChange(number); }}
    onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>;
}

export default function TextOverlaysEditor({ value = [], onChange, duration, currentTime = 0, onSeek, disabled = false, scopeDescription, compact = false }: {
  value?: TextOverlay[]; onChange: (items: TextOverlay[]) => void; duration?: number; currentTime?: number;
  onSeek?: (time: number) => void; disabled?: boolean; scopeDescription?: string; compact?: boolean;
}) {
  const [title, setTitle] = useState(''), [design, setDesign] = useState<typeof TITLE_DESIGNS[number]['id']>('bold');
  const update = (id: string, patch: Partial<TextOverlay>) => onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  return <section className="text-editor" aria-label="Text overlays">
    <details className="text-editor-disclosure" open={!compact || value.length > 0}>
      <summary><span className="text-editor-heading"><Type size={17} />Titles &amp; custom text</span><span className="text-editor-count">{value.length ? `${value.length} added` : "Optional"}</span></summary>
    <p className="text-editor-note">Add your own titles and words, separately from speech captions.</p>
    {scopeDescription && <p className="text-editor-note">{scopeDescription}. Text edits copy all words, timings and styles shown here to this selection.</p>}
    <fieldset disabled={disabled}>
      <details className="title-composer" open={!value.length}><summary>Ready-made titles</summary>
        <div className="title-designs" role="group" aria-label="Title designs">
          {TITLE_DESIGNS.map(preset => <button key={preset.id} type="button" aria-pressed={design === preset.id} onClick={() => setDesign(preset.id)}>
            <span style={{ fontFamily: CAPTION_FONTS[preset.style.fontFamily].css, color: preset.style.color,
              ...(preset.id === 'announcement' ? { background: '#f5dcac', borderRadius: 3, padding: 4 } : {}) }}>{preset.sample}</span><small>{preset.name}</small>
          </button>)}
        </div>
        <label>Title words<textarea aria-label="Title words" rows={2} maxLength={500} placeholder="Write a title for the selected videos" value={title} onChange={event => setTitle(event.target.value)} /></label>
        <button type="button" className="secondary-button text-editor-add" disabled={!title.trim() || value.length >= MAX_TEXT_OVERLAYS} onClick={() => {
          onChange([...value, titleOverlay(crypto.randomUUID(), design, title.trim(), 0, Math.max(.04, Math.min(3, duration || 3)))]);
          onSeek?.(0); setTitle('');
        }}><Plus size={15} />Add title</button>
        <p className="text-editor-note">Starts at the beginning. Adjust its words, timing, animation or size below.</p>
      </details>
      {value.map((item, index) => <details className="text-editor-item" key={item.id} open>
        <summary>Text {index + 1} <span>{item.start.toFixed(1)}–{item.end.toFixed(1)}s</span></summary>
        <label>Words<textarea aria-label={`Text ${index + 1} words`} rows={2} maxLength={500} value={item.text} onChange={event => update(item.id, { text: event.target.value })} /></label>
        <div className="text-editor-times">
          <TimeField label={`Text ${index + 1} start`} value={item.start} min={0} onChange={start => update(item.id, { start: Math.min(start, 86399.96), end: Math.max(item.end, Math.min(start + .04, 86400)) })} />
          <TimeField label={`Text ${index + 1} end`} value={item.end} min={item.start + .04} onChange={end => update(item.id, { end })} />
        </div>
        {duration !== undefined && item.end > duration + .001 && <p className="text-editor-note" role="status">{item.start >= duration ? "This text starts after the current video ends." : "This text ends with the video if the video is shorter."}</p>}
        <div className="text-editor-actions">
          {onSeek && <button type="button" className="secondary-button" onClick={() => onSeek(item.start)}>Preview at start</button>}
          <button type="button" className="secondary-button" aria-label={`Remove text ${index + 1}`} onClick={() => onChange(value.filter(other => other.id !== item.id))}><Trash2 size={13} />Remove</button>
        </div>
        <details className="text-editor-appearance" open={!compact}><summary>Style, animation &amp; position</summary>
          <CaptionStyleEditor value={item.style} sample={item.text} showHighlight={false} showPreview={false} textMode onChange={style => update(item.id, { style: { ...style, wordHighlight: false } })} />
          <div className="text-position-presets" aria-label={`Text ${index + 1} position presets`}>
            {([['Top', 75], ['Center', 45], ['Bottom', 10]] as const).map(([label, bottomPercent]) => <button type="button" className="secondary-button" key={label} onClick={() => update(item.id, { xPercent: 50, style: { ...item.style, bottomPercent } })}>{label}</button>)}
          </div>
          <NumberControl label="Horizontal position" value={item.xPercent} min={5} max={95} suffix="%" onChange={xPercent => update(item.id, { xPercent })} />
          <NumberControl label="Distance from bottom" value={item.style.bottomPercent} min={5} max={80} suffix="%" onChange={bottomPercent => update(item.id, { style: { ...item.style, bottomPercent } })} />
          <NumberControl label="Text width" value={item.widthPercent} min={10} max={90} suffix="%" onChange={widthPercent => update(item.id, { widthPercent })} />
        </details>
      </details>)}
      <button type="button" className="secondary-button text-editor-add" disabled={value.length >= MAX_TEXT_OVERLAYS || disabled} onClick={() => {
        const start = Math.min(86399.96, Math.max(0, duration ? Math.min(currentTime, Math.max(0, duration - .1)) : currentTime));
        const end = Math.min(86400, Math.max(start + .04, Math.min(start + 3, duration || start + 3)));
        onChange([...value, newTextOverlay(crypto.randomUUID(), start, end)]);
      }}><Plus size={15} />Add text</button>
      <p className="text-editor-note">Drag text in the preview to move it; select it and drag the corner to resize. Times follow the finished video, including added clips, and stay fixed when cuts change.</p>
    </fieldset>
    </details>
  </section>;
}
