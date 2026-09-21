import type { CSSProperties } from "react";
import { bandTextLayout, DEFAULT_BLACK_BANDS, type BlackBands } from "../shared/black-bands";
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
      [value.topText, value.topPercent * 10, 0],
      [value.bottomText, value.bottomPercent * 10, 1000 - value.bottomPercent * 10],
    ] as const).map(([text, bandHeight, top], index) => {
      const layout = bandTextLayout(text, width, height, bandHeight, value.fontPercent);
      const lines = layout.text.split("\n");
      const first = top + bandHeight / 2 - (lines.length - 1) * layout.fontSize * 1.25 / 2;
      return <g key={index}>
        <rect x={0} y={top} width={width} height={bandHeight} fill="black" />
        <text fill="white" textAnchor="middle" dominantBaseline="central" fontFamily="Arial, sans-serif" fontWeight="700" fontSize={layout.fontSize}>
          {lines.map((line, lineIndex) => <tspan key={lineIndex} x={width / 2} y={first + lineIndex * layout.fontSize * 1.25}>{line}</tspan>)}
        </text>
      </g>;
    })}
  </svg>;
}

export default function BlackBandsEditor({ value, onChange, aspect = 9 / 16, source }: {
  value?: BlackBands; onChange: (value: BlackBands) => void; aspect?: number;
  source?: { thumbnailUrl: string; width: number; height: number };
}) {
  const bands = value ?? DEFAULT_BLACK_BANDS;
  const update = (patch: Partial<BlackBands>) => onChange({ ...bands, ...patch });
  return <div className="black-bands-editor">
    <label className="black-bands-toggle"><input type="checkbox" checked={bands.enabled} onChange={event => update({ enabled: event.target.checked })} />
      <span><strong>Black bands</strong><small>Make room above and below the video for your words.</small></span>
    </label>
    {bands.enabled && <>
      <div className="black-bands-sample" style={{ aspectRatio: aspect, width: `min(100%, ${200 * aspect}px)` }} aria-label="Black bands layout preview">
        {source ? <img src={source.thumbnailUrl} alt="Source video in the selected layout" style={bandVideoStyle(bands)} />
          : <div className="black-bands-placeholder" style={bandVideoStyle(bands)}>Your video</div>}
        <BlackBandsOverlay value={bands} aspect={aspect} />
      </div>
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
      <label>Top band text<textarea rows={3} maxLength={200} value={bands.topText} placeholder="Write a headline or caption…" onChange={event => update({ topText: event.target.value })} /></label>
      <label>Bottom band text<textarea rows={2} maxLength={200} value={bands.bottomText} placeholder="Optional second caption…" onChange={event => update({ bottomText: event.target.value })} /></label>
      <Slider label="Band text size" value={bands.fontPercent} defaultValue={5.4} min={3} max={10} step={0.1} unit="%" onChange={fontPercent => update({ fontPercent })} />
      <p className="black-bands-hint">White text stays on screen throughout the video and shrinks to fit. Speech captions keep their separate styling; leave the bottom text blank if captions appear there. Opening hooks appear over the video.</p>
    </>}
  </div>;
}
