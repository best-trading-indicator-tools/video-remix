import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { RotateCcw, Check, ChevronDown, Type } from "lucide-react";
import { CAPTION_FONTS, CAPTION_PRESETS, CAPTION_FONT_SIZE_MIN, CAPTION_FONT_SIZE_MAX, DEFAULT_CAPTION_STYLE, captionLines, captionWordStarts, captionStyleSchema, contrastingHighlight, resolveCaptionStyle, type CaptionStyle } from "../shared/caption-style";
import { captionDisplayText } from "../shared/caption-text";
import { TEXT_ANIMATIONS, textMotion, typewriterCount } from '../shared/text-animation';
import "./caption-style.css";

export function CaptionAppearance(props: Parameters<typeof CaptionStyleEditor>[0]) {
  return <>
    <WordHighlightToggle value={props.value} onChange={props.onChange} />
    <CaptionAnimationControl value={props.value} onChange={props.onChange} />
    <details className="caption-appearance">
      <summary>
        <Type size={20} className="caption-appearance-icon" aria-hidden="true" />
        <span className="caption-appearance-copy">
          <strong>Caption appearance</strong>
          <small>Font, size, color, effects &amp; Cyrillic lookalikes</small>
        </span>
        <ChevronDown size={20} className="caption-appearance-chevron" aria-hidden="true" />
      </summary>
      <CaptionStyleEditor {...props} showHighlight={false} showAnimation={false} />
    </details>
  </>;
}

/** On/off for TikTok-style captions: the word being spoken lights up. */
export function WordHighlightToggle({ value, onChange }: { value?: CaptionStyle; onChange: (style: CaptionStyle) => void }) {
  const s = resolveCaptionStyle(value);
  return <div className="caption-highlight">
    <label className="caption-highlight-toggle">
      <input type="checkbox" checked={s.wordHighlight} onChange={event => onChange({ ...s, wordHighlight: event.target.checked,
        highlightColor: event.target.checked && !value?.highlightColor ? contrastingHighlight(s.color) : s.highlightColor })} />
      <span><strong>Highlight each word as it’s spoken</strong>
        <small>{s.wordHighlight ? "Uses speech timings when available; imported or rewritten captions use estimated timing." : "Off: each caption appears in one color."}</small></span>
    </label>
    {s.wordHighlight && <ColorControl label="Highlight color" value={s.highlightColor} onChange={highlightColor => onChange({ ...s, highlightColor })} />}
  </div>;
}

/** Index of the word being spoken at `time`, using the same timing as the export's fallback. */
export function activeCaptionWord(text: string, start: number, end: number, time: number, words?: { start: number; end: number; word: string }[]): number {
  const starts = captionWordStarts(text, start, end, words);
  let active = 0;
  starts.forEach((at, index) => { if (at <= time) active = index; });
  return active;
}

export function CaptionOverlay({ style, height, text, activeWord, placement, displayed = false, blockBackground = false, time = 1, start = 0, end = 4 }: { style?: CaptionStyle; height: number; text: string; activeWord?: number; placement?: CSSProperties; displayed?: boolean; blockBackground?: boolean; time?: number; start?: number; end?: number }) {
  const s = resolveCaptionStyle(style), scale = height / 288;
  const box = s.background === "box";
  const color = s.backgroundColor;
  const background = `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${s.backgroundOpacity / 100})`;
  const lettering: CSSProperties = {
    fontFamily: placement?.fontFamily ?? CAPTION_FONTS[s.fontFamily].css, fontSize: s.fontSize * scale,
    fontWeight: s.bold ? 700 : 400, fontStyle: s.italic ? "italic" : "normal",
    color: s.color, letterSpacing: s.letterSpacing * scale,
    WebkitTextStroke: !box && s.outlineWidth ? `${s.outlineWidth * scale * (placement ? 2 : 1)}px ${s.outlineColor}` : undefined,
    textShadow: s.shadow ? `${s.shadow * scale}px ${s.shadow * scale}px 0 #000` : "none",
    ...(box ? blockBackground
      // A single shrink-to-fit block covers every line. Spread adds padding
      // outside the line boxes without moving the text or its drag anchor.
      ? { display: "inline-block", verticalAlign: "top", backgroundColor: background, boxShadow: `0 0 0 ${3 * scale}px ${background}` }
      : { backgroundColor: background, padding: `${3 * scale}px`, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } : {}),
  };
  const shown = displayed ? text : captionDisplayText(text, s);
  const motion = textMotion(s, start, end, time);
  if (s.animation !== 'none') Object.assign(lettering, { display: 'inline-block', opacity: motion.opacity,
    transform: `translateY(${motion.y * scale}px) scale(${motion.scale})`, transformOrigin: `${s.alignment} bottom` });
  let index = 0;
  const active = activeWord ?? activeCaptionWord(text, start, end, time);
  let characters = 0;
  const visible = typewriterCount(shown, start, end, time);
  let inWord = false, typedWord = -1;
  const words = s.animation === 'typewriter' ? Array.from(shown).map((char, i) => {
    const whitespace = /\s/u.test(char);
    if (!whitespace && !inWord) typedWord++;
    inWord = !whitespace;
    return <span key={i} style={{ visibility: characters++ < visible ? 'visible' : 'hidden', color: s.wordHighlight && typedWord === active && !whitespace ? s.highlightColor : undefined }}>{char}</span>;
  })
    : s.wordHighlight || s.animation === 'words' ? captionLines(shown).map((row, rowIndex) => <Fragment key={rowIndex}>
    {rowIndex > 0 && "\n"}{row.map((word, wordIndex) => { const current = index++; return <Fragment key={wordIndex}>{wordIndex > 0 && " "}
      <span className={s.wordHighlight && current === active ? 'caption-word-active' : undefined} style={{ color: s.wordHighlight && current === active ? s.highlightColor : undefined,
        visibility: s.animation === 'words' && current > active ? 'hidden' : 'visible' }}>{word}</span></Fragment>; })}
  </Fragment>) : shown;
  return <div className="caption-overlay" style={{ bottom: `${s.bottomPercent}%`, textAlign: s.alignment, ...placement }}><span style={lettering}>{words}</span></div>;
}

export function NumberControl({ label, value, min, max, step = 1, suffix, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void;
}) {
  const [input, setInput] = useState(String(Number(value.toFixed(2))));
  useEffect(() => setInput(String(Number(value.toFixed(2)))), [value]);
  const commit = () => { const n = Number(input); const next = input.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value; onChange(next); setInput(String(Number(next.toFixed(2)))); };
  return <div className="caption-number"><label><span>{label}{suffix && <small>{suffix}</small>}</span>
    <input aria-label={label} type="number" min={min} max={max} step="any" value={input}
      onChange={event => { setInput(event.target.value); const n = event.target.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) onChange(n); }}
      onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
  </label><input aria-label={`${label} slider`} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(event.target.valueAsNumber)} /></div>;
}
function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [input, setInput] = useState(value);
  useEffect(() => setInput(value), [value]);
  return <label className="caption-color"><span>{label}</span><span className="caption-color-inputs">
    <input type="color" aria-label={`${label} picker`} value={value} onChange={event => onChange(event.target.value)} />
    <input type="text" aria-label={label} value={input} maxLength={7} pattern="#[0-9a-fA-F]{6}" spellCheck={false} onChange={event => {
      const next = event.target.value; setInput(next); if (/^#[0-9a-fA-F]{6}$/u.test(next)) onChange(next);
    }} onBlur={() => setInput(value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
  </span></label>;
}

export function SampleCaptionOverlay({ style, height, sample = "Caption style preview" }: { style?: CaptionStyle; height: number; sample?: string }) {
  const s = resolveCaptionStyle(style);
  const previewText = sample.trim().slice(0, 120) || "Make every word count.";
  const wordCount = captionLines(previewText).flat().length;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if ((!s.wordHighlight && s.animation === 'none') || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 33);
    return () => clearInterval(timer);
  }, [s.wordHighlight, s.animation]);
  const time = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 2 : tick * .033 % 4;
  return <CaptionOverlay style={s} height={height} text={previewText} time={time} activeWord={wordCount ? activeCaptionWord(previewText, 0, 4, time) : undefined} />;
}

export function CaptionAnimationControl({ value, onChange }: { value?: CaptionStyle; onChange: (style: CaptionStyle) => void }) {
  const s = resolveCaptionStyle(value);
  return <div className="caption-animation"><label className="caption-field">Animation
    <select aria-label="Text animation" value={s.animation} onChange={event => onChange({ ...s, animation: event.target.value as CaptionStyle['animation'] })}>
      {TEXT_ANIMATIONS.map(animation => <option key={animation.id} value={animation.id}>{animation.label}</option>)}
    </select>
  </label>{['fade', 'pop', 'slide'].includes(s.animation) && <NumberControl label="Animation duration" min={.1} max={1} step={.05} value={s.animationDuration} suffix="s" onChange={animationDuration => onChange({ ...s, animationDuration })} />}
  {s.animation === 'words' && <p className="caption-style-note">Words appear as they are spoken. Imported or corrected wording uses estimated timing.</p>}</div>;
}

const parseSpellingWords = (text: string) => [...new Set(text.split(/[,\n]/u).map(word => word.trim()).filter(Boolean))];
function CyrillicControl({ style, onChange, sample, textMode = false }: { style: Required<CaptionStyle>; onChange: (change: Partial<CaptionStyle>) => void; sample: string; textMode?: boolean }) {
  const savedWords = style.cyrillicWords.join("\n");
  const [input, setInput] = useState(savedWords);
  // Keep separators while typing, but follow a different video's settings or a preset.
  useEffect(() => setInput(current => parseSpellingWords(current).join("\n") === savedWords ? current : savedWords), [savedWords]);
  const valid = captionStyleSchema.shape.cyrillicWords.safeParse(parseSpellingWords(input)).success;
  const examples = style.cyrillicMode === "words" ? style.cyrillicWords : [sample];
  return <div className="caption-spelling">
    <label className="caption-field">Cyrillic lookalikes
      <select value={style.cyrillicMode} onChange={event => onChange({ cyrillicMode: event.target.value as CaptionStyle["cyrillicMode"] })}>
        <option value="off">Off · original spelling</option>
        <option value="words">Only listed words</option>
        <option value="all">{textMode ? "All this text" : "All caption text"}</option>
      </select>
    </label>
    {style.cyrillicMode !== "off" && <>
      <p className="caption-style-note">Swaps similar-looking Latin letters for Cyrillic characters. This does not translate the text. {textMode ? "Your typed text stays editable." : "Original captions and speech timings stay saved."}</p>
      {style.cyrillicMode === "words" && <>
        <label className="caption-field">Words to change
          <textarea value={input} rows={3} maxLength={4050} placeholder={"Sample-12\nExample phrase"} spellCheck={false} aria-invalid={!valid} onChange={event => {
            const text = event.target.value; setInput(text);
            const parsed = captionStyleSchema.shape.cyrillicWords.safeParse(parseSpellingWords(text));
            if (parsed.success) onChange({ cyrillicWords: parsed.data });
          }} />
        </label>
        <p className="caption-style-note">Up to 50 words or phrases, one per line or separated by commas. Matches whole words, ignoring case.</p>
        {!valid && <p role="alert" className="caption-spelling-error">Use at most 50 entries of 80 characters each. Your last valid list is still applied.</p>}
      </>}
      {examples.length > 0 ? <div className="caption-spelling-preview" aria-label="Cyrillic spelling preview">
        {examples.slice(0, 5).map((text, index) => <div key={index}>
          <span>{text}</span><span aria-hidden="true">→</span>
          <span style={{ fontFamily: CAPTION_FONTS[style.fontFamily].css, fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? "italic" : "normal" }}>{captionDisplayText(text, style)}</span>
        </div>)}
        {examples.length > 5 && <small>+ {examples.length - 5} more entries</small>}
      </div> : <p className="caption-style-note">Add a word to preview its spelling. Captions stay unchanged until you add words.</p>}
      <p className="caption-style-note">TikTok Sans supports these characters. Other fonts may use fallback letters.</p>
    </>}
  </div>;
}

export default function CaptionStyleEditor({ value, onChange, sample = "Make every word count.", showHighlight = true, showPreview = true, showAnimation = true, textMode = false }: {
  value?: CaptionStyle; onChange: (style: CaptionStyle) => void; sample?: string; showHighlight?: boolean; showPreview?: boolean; showAnimation?: boolean; textMode?: boolean;
}) {
  const s = resolveCaptionStyle(value);
  const patch = (change: Partial<CaptionStyle>) => onChange({ ...s, ...change });
  return <section className="caption-styler" aria-label={textMode ? "Text styling" : "Caption styling"}>
    <header><div><h4>{textMode ? "Text look" : "Caption look"}</h4><p>{textMode ? "Font, color, background, outline, shadow and letter spacing for this text." : "One style for all added captions."}</p></div>
      <button type="button" className="caption-reset" aria-label={textMode ? "Reset text style" : "Reset caption style"} onClick={() => onChange({ ...DEFAULT_CAPTION_STYLE, ...(textMode ? { bottomPercent: s.bottomPercent, fontFamily: "poppins" } : {}) })}><RotateCcw size={14} />Reset</button></header>
    {showHighlight && <WordHighlightToggle value={value} onChange={onChange} />}
    {showAnimation && <CaptionAnimationControl value={value} onChange={onChange} />}
    <div className="caption-looks" role="group" aria-label={textMode ? "Text look presets" : "Caption look presets"}>
      {CAPTION_PRESETS.map(preset => {
        const selected = Object.entries(preset.style).every(([key, v]) => s[key as keyof CaptionStyle] === v);
        return <button type="button" key={preset.id} aria-pressed={selected} title={preset.description}
          onClick={() => onChange({ ...s, ...preset.style, ...(textMode ? { bottomPercent: s.bottomPercent } : {}) })}>
          <span className={`caption-look-sample look-${preset.id}`} style={{ fontFamily: CAPTION_FONTS[preset.style.fontFamily!].css, color: preset.style.color }}>Aa</span>
          <span>{preset.name}{selected && <Check size={12} />}</span>
        </button>;
      })}
    </div>
    {showPreview && <div className="caption-type-preview" aria-label="Live caption style preview">
      <span className="caption-preview-label">Type preview</span>
      <SampleCaptionOverlay style={{ ...s, bottomPercent: 26 }} height={360} sample={sample} />
    </div>}
    <div className="caption-style-grid">
      <label className="caption-field">Font family<select value={s.fontFamily} onChange={event => patch({ fontFamily: event.target.value as CaptionStyle["fontFamily"] })}>
        {Object.entries(CAPTION_FONTS).filter(([id]) => !textMode || id !== "classic").map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}
      </select></label>
      <ColorControl label="Text color" value={s.color} onChange={color => patch({ color })} />
      <label className="caption-field">Background<select value={s.background} onChange={event => patch({ background: event.target.value as CaptionStyle["background"] })}><option value="none">None · transparent</option><option value="box">Solid box</option></select></label>
      {s.background === "box" && <ColorControl label="Background color" value={s.backgroundColor} onChange={backgroundColor => patch({ backgroundColor })} />}
    </div>
    {s.background === "box" && <NumberControl label="Background opacity" value={s.backgroundOpacity} min={0} max={100} suffix="%" onChange={backgroundOpacity => patch({ backgroundOpacity })} />}
    <div className="caption-emphasis" role="group" aria-label={textMode ? "Text emphasis" : "Caption emphasis"}>
      {([['bold', 'Bold'], ['italic', 'Italic'], ['uppercase', 'ALL CAPS']] as const).map(([key, name]) => <button type="button" key={key} aria-pressed={s[key]} onClick={() => patch({ [key]: !s[key] })}>{name}</button>)}
    </div>
    <CyrillicControl style={s} onChange={patch} sample={sample} textMode={textMode} />
    <NumberControl label={textMode ? "Text font size" : "Caption font size"} value={s.fontSize} min={CAPTION_FONT_SIZE_MIN} max={CAPTION_FONT_SIZE_MAX} step={0.5} onChange={fontSize => patch({ fontSize })} />
    <p className="caption-style-note">Size scales with your export resolution.</p>
    <details className="caption-more" open={textMode}><summary>{textMode ? "Outline, shadow & spacing" : "Outline, shadow, spacing & placement"}</summary>
      <label className="caption-field">Text alignment<select value={s.alignment} onChange={event => patch({ alignment: event.target.value as CaptionStyle["alignment"] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
      {s.background === "box" ? <p className="caption-style-note">The box replaces the text outline.</p> : <>
        <ColorControl label="Outline color" value={s.outlineColor} onChange={outlineColor => patch({ outlineColor })} />
        <NumberControl label="Outline thickness" value={s.outlineWidth} min={0} max={5} step={0.1} onChange={outlineWidth => patch({ outlineWidth })} />
      </>}
      <NumberControl label="Shadow" value={s.shadow} min={0} max={5} step={0.1} onChange={shadow => patch({ shadow })} />
      <NumberControl label="Letter spacing" value={s.letterSpacing} min={0} max={4} step={0.1} onChange={letterSpacing => patch({ letterSpacing })} />
      {!textMode && <NumberControl label="Distance from bottom" value={s.bottomPercent} min={5} max={80} step={0.1} suffix="%" onChange={bottomPercent => patch({ bottomPercent })} />}
    </details>
  </section>;
}
