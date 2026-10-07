import type { CSSProperties } from "react";
import { bandTextAppearance, bandTextLayout, DEFAULT_BLACK_BANDS, type BandSide, type BandTextStyle, type BlackBands } from "../shared/black-bands";
import Slider from "./Slider";
import "./black-bands.css";

export function bandVideoStyle(bands?: BlackBands): CSSProperties {
  return bands?.enabled ? {
    position: "absolute", left: 0, top: `${bands.topPercent}%`, width: "100%",
    height: `${100 - bands.topPercent - bands.bottomPercent}%`,
    objectFit: bands.fit === "crop" ? "cover" : "contain",
  } : {};
}

export function bandEditorialStyle(bands: BlackBands | undefined, height: number, aspect: number, position: number, scale: number): CSSProperties {
  const top = bands?.enabled ? bands.topPercent : 0;
  const content = bands?.enabled ? 100 - bands.topPercent - bands.bottomPercent : 100;
  return { top: `${top + content * position}%`, fontSize: `${height * Math.min(aspect, content / 100) * scale}px` };
}

export function BlackBandsOverlay({ value, aspect }: { value?: BlackBands; aspect: number }) {
  if (!value?.enabled) return null;
  const width = 1000 * aspect, height = 1000;
  return <svg className="black-bands-overlay" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {([
      ["top", value.topPercent * 10, 0],
      ["bottom", value.bottomPercent * 10, 1000 - value.bottomPercent * 10],
    ] as const).map(([side, bandHeight, top]) => {
      const appearance = bandTextAppearance(value, side);
      const layout = bandTextLayout(appearance.text, width, height, bandHeight, appearance.fontPercent);
      const lines = layout.text.split("\n");
      const first = top + bandHeight / 2 - (lines.length - 1) * layout.fontSize * 1.25 / 2;
      return <g key={side}>
        <rect x={0} y={top} width={width} height={bandHeight} fill="black" />
        <text fill={appearance.color} textAnchor="middle" dominantBaseline="central" fontFamily="Arial, sans-serif" fontWeight="700" fontSize={layout.fontSize}>
          {lines.map((line, lineIndex) => <tspan key={lineIndex} x={width / 2} y={first + lineIndex * layout.fontSize * 1.25}>{line}</tspan>)}
        </text>
      </g>;
    })}
  </svg>;
}

function BandTextEditor({ bands, side, onChange }: { bands: BlackBands; side: BandSide; onChange: (patch: Partial<BlackBands>) => void }) {
  const label = side === "top" ? "Top" : "Bottom";
  const appearance = bandTextAppearance(bands, side);
  const updateStyle = (patch: BandTextStyle) => onChange({ [`${side}Style`]: { ...bands[`${side}Style`], ...patch } });
  return <fieldset className="band-text-editor">
    <legend>{label} band text</legend>
    <textarea aria-label={`${label} band text`} rows={2} maxLength={200} value={bands[`${side}Text`]} placeholder={side === "top" ? "Write a headline or caption…" : "Optional second caption…"} onChange={event => onChange({ [`${side}Text`]: event.target.value })} />
    <label className="band-text-color">Text color<input aria-label={`${label} band text color`} type="color" value={appearance.color} onChange={event => updateStyle({ color: event.target.value })} /></label>
    <Slider label={`${label} text size${appearance.fontPercent === 5.4 ? " · Medium" : ""}`} value={appearance.fontPercent} defaultValue={5.4} min={3} max={10} step={0.1} unit="%" onChange={fontPercent => updateStyle({ fontPercent })} />
    <label className="black-bands-toggle"><input type="checkbox" checked={appearance.cyrillic} onChange={event => updateStyle({ cyrillic: event.target.checked })} />
      <span>{label} band Cyrillic lookalikes</span>
    </label>
    {appearance.cyrillic && bands[`${side}Text`].trim() && <p className="black-bands-hint">Displayed: {appearance.text}</p>}
  </fieldset>;
}

export default function BlackBandsEditor({ value, onChange }: {
  value?: BlackBands; onChange: (value: BlackBands) => void;
}) {
  const bands = value ?? DEFAULT_BLACK_BANDS;
  const update = (patch: Partial<BlackBands>) => onChange({ ...bands, ...patch });
  return <div className="black-bands-editor">
    <label className="black-bands-toggle"><input type="checkbox" checked={bands.enabled} onChange={event => update({ enabled: event.target.checked })} />
      <span><strong>Black bands</strong><small>Make room above and below the video for your words.</small></span>
    </label>
    {bands.enabled && <>
      <label>Video inside the bands
        <select value={bands.fit} onChange={event => update({ fit: event.target.value as BlackBands["fit"] })}>
          <option value="contain">Keep the whole picture</option>
          <option value="crop">Fill the window · crop edges</option>
        </select>
      </label>
      <p className="black-bands-hint">{bands.fit === "contain"
        ? "Landscape stays a mini widescreen. Portrait stays fully visible, with black space at the sides too."
        : "A wider window fills the canvas width. Portrait footage loses some of the top and bottom. Adjust the subject position in Manual or Edit this result."}</p>
      <Slider label="Top band" value={bands.topPercent} defaultValue={25} min={10} max={Math.min(40, 70 - bands.bottomPercent)} step={1} unit="%" onChange={topPercent => update({ topPercent })} />
      <Slider label="Bottom band" value={bands.bottomPercent} defaultValue={15} min={10} max={Math.min(40, 70 - bands.topPercent)} step={1} unit="%" onChange={bottomPercent => update({ bottomPercent })} />
      <BandTextEditor bands={bands} side="top" onChange={update} />
      <BandTextEditor bands={bands} side="bottom" onChange={update} />
      <p className="black-bands-hint">Band text stays on screen throughout the video and shrinks to fit. Cyrillic lookalikes swap similar letters for display; your typed text stays editable. Speech captions keep their separate styling; leave the bottom text blank if captions appear there. Opening hooks appear over the video.</p>
    </>}
  </div>;
}
