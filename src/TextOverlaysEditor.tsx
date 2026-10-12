import { useEffect, useState } from "react";
import { Plus, Trash2, Type } from "lucide-react";
import CaptionStyleEditor, { CaptionOverlay, NumberControl } from "./CaptionStyleEditor";
import { MAX_TEXT_OVERLAYS, TEXT_LINE_HEIGHT, newTextOverlay, textOverlayLayout, type TextOverlay } from "../shared/text-overlays";
import "./text-overlays.css";

export function TextOverlaysPreview({ items, time, height, aspect }: { items?: TextOverlay[]; time: number; height: number; aspect: number }) {
  if (!(height > 0 && aspect > 0)) return null;
  return <>{items?.filter(item => item.text.trim() && time >= item.start && time < item.end).map(item => {
    const layout = textOverlayLayout(item, height * aspect, height);
    return <CaptionOverlay key={item.id} style={{ ...item.style, wordHighlight: false }} height={height} text={layout.text} displayed
      placement={{ left: `${layout.left / (height * aspect) * 100}%`, width: `${layout.width / (height * aspect) * 100}%`, right: "auto", zIndex: 4,
        whiteSpace: "pre", overflowWrap: "normal", fontSize: item.style.fontSize * height / 288, fontFamily: layout.metrics.css, lineHeight: TEXT_LINE_HEIGHT }} />;
  })}</>;
}

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

export default function TextOverlaysEditor({ value = [], onChange, duration, currentTime = 0, onSeek, disabled = false }: {
  value?: TextOverlay[]; onChange: (items: TextOverlay[]) => void; duration?: number; currentTime?: number;
  onSeek?: (time: number) => void; disabled?: boolean;
}) {
  const update = (id: string, patch: Partial<TextOverlay>) => onChange(value.map(item => item.id === id ? { ...item, ...patch } : item));
  return <section className="text-editor" aria-label="Text overlays">
    <header><div><h3><Type size={17} />Text</h3><p>Add words directly over the video, with or without black bands.</p></div></header>
    <fieldset disabled={disabled}>
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
        <details className="text-editor-appearance"><summary>Style &amp; position</summary>
          <div className="text-position-presets" aria-label={`Text ${index + 1} position presets`}>
            {([['Top', 75], ['Center', 45], ['Bottom', 10]] as const).map(([label, bottomPercent]) => <button type="button" className="secondary-button" key={label} onClick={() => update(item.id, { xPercent: 50, style: { ...item.style, bottomPercent } })}>{label}</button>)}
          </div>
          <NumberControl label="Horizontal position" value={item.xPercent} min={5} max={95} suffix="%" onChange={xPercent => update(item.id, { xPercent })} />
          <NumberControl label="Distance from bottom" value={item.style.bottomPercent} min={5} max={80} suffix="%" onChange={bottomPercent => update(item.id, { style: { ...item.style, bottomPercent } })} />
          <NumberControl label="Text width" value={item.widthPercent} min={10} max={90} suffix="%" onChange={widthPercent => update(item.id, { widthPercent })} />
          <CaptionStyleEditor value={item.style} sample={item.text} showHighlight={false} showPreview={false} textMode onChange={style => update(item.id, { style: { ...style, wordHighlight: false } })} />
        </details>
      </details>)}
      <button type="button" className="secondary-button text-editor-add" disabled={value.length >= MAX_TEXT_OVERLAYS || disabled} onClick={() => {
        const start = Math.min(86399.96, Math.max(0, duration ? Math.min(currentTime, Math.max(0, duration - .1)) : currentTime));
        const end = Math.min(86400, Math.max(start + .04, Math.min(start + 3, duration || start + 3)));
        onChange([...value, newTextOverlay(crypto.randomUUID(), start, end)]);
      }}><Plus size={15} />Add text</button>
      <p className="text-editor-note">Times follow the finished video, including added clips. They stay fixed when you change cuts. Each text has its own style; speech captions stay separate.</p>
    </fieldset>
  </section>;
}
