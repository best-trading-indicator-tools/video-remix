import { useEffect, useState, type CSSProperties } from "react";
import { RotateCcw } from "lucide-react";
import { coerceManualNumber } from "../shared/manual";

export default function Slider({ label, value, defaultValue, min, max, step = 0.01, unit = "", onChange, hint }: {
  label: string; value: number; defaultValue: number; min: number; max: number; step?: number; unit?: string;
  onChange: (value: number) => void; hint?: string;
}) {
  const id = `slider-${label.replaceAll(" ", "-").toLowerCase()}`;
  const digits = Math.max(0, (String(step).split(".")[1] || "").length);
  const [draft, setDraft] = useState(value.toFixed(digits));
  useEffect(() => setDraft(value.toFixed(digits)), [value, digits]);
  const commit = (input: string) => {
    if (input === value.toFixed(digits)) return;
    const next = coerceManualNumber(input, value, min, max, step);
    setDraft(next.toFixed(digits));
    onChange(next);
  };
  return <div className={`slider-field ${Math.abs(value - defaultValue) > 1e-8 ? "is-adjusted" : ""}`}>
    <div className="field-heading">
      <label htmlFor={id}>{label}</label>
      <div className="slider-value-controls">
        <div className="slider-number-wrap">
          <input type="number" aria-label={`${label} value`} min={min} max={max} step={step} value={draft}
            onChange={(event) => setDraft(event.target.value)} onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.value = value.toFixed(digits); setDraft(value.toFixed(digits)); event.currentTarget.blur(); }
            }} />
          {unit && <span aria-hidden="true">{unit}</span>}
        </div>
        <button type="button" className="slider-reset" aria-label={`Reset ${label.toLowerCase()}`} title={`Reset to ${defaultValue}${unit}`} disabled={Math.abs(value - defaultValue) < 1e-8} onClick={() => onChange(defaultValue)}><RotateCcw size={13} /></button>
      </div>
    </div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.valueAsNumber)}
      style={{ "--range-fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties} />
    {hint && <p className="field-hint">{hint}</p>}
  </div>;
}
