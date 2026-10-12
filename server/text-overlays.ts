import { assColor, CAPTION_FONTS } from "../shared/caption-style.js";
import { textOverlayLayout, textOverlaysSchema, TEXT_LINE_HEIGHT, type TextOverlay } from "../shared/text-overlays.js";
import { animatedAssText, animatedTextFrames, assOpacity } from './text-animation.js';

const stamp = (seconds: number) => {
  const n = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
};
// User text must never become an ASS override or a newline escape.
const literal = (text: string) => text.replace(/\\/gu, "\\\u200b").replace(/\{/gu, "(").replace(/\}/gu, ")").replace(/\n/gu, "\\N");

export function textOverlaysAss(items: TextOverlay[], width: number, height: number, duration: number): string {
  const styles: string[] = [], events: string[] = [], scale = height / 288;
  for (const [index, item] of textOverlaysSchema.parse(items).entries()) {
    if (!item.text.trim() || item.start >= duration) continue;
    const { text, style: s, left, width: boxWidth, bottom, metrics } = textOverlayLayout(item, width, height);
    const name = `Text${index}`, box = s.background === "box";
    const alignment = { left: 1, center: 2, right: 3 }[s.alignment];
    const x = left + boxWidth * ({ left: 0, center: .5, right: 1 }[s.alignment]);
    const fontSize = s.fontSize * scale, assSize = fontSize * (metrics.ascent + metrics.descent);
    const frames = animatedTextFrames(text, text, s, item.start, Math.min(item.end, duration));
    styles.push(`Style: ${name},${CAPTION_FONTS[s.fontFamily].family},${assSize},${assColor(s.color)},${assColor(s.color)},${assColor(s.outlineColor)},&H00000000,${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,100,${s.letterSpacing * scale},0,1,${(box ? 0 : s.outlineWidth) * scale},${s.shadow * scale},${alignment},0,0,0,1`);
    if (box) {
      // Libass BorderStyle 4 draws one rectangle for the whole event. Invisible
      // glyphs measure its width; vertical scale matches the preview's line boxes.
      // Lettering stays in separate events so its existing baselines do not move.
      const backgroundName = `${name}Background`, scaleY = 100 * TEXT_LINE_HEIGHT / (metrics.ascent + metrics.descent);
      styles.push(`Style: ${backgroundName},${CAPTION_FONTS[s.fontFamily].family},${assSize},&HFFFFFFFF,&HFFFFFFFF,&HFFFFFFFF,${assColor(s.backgroundColor, s.backgroundOpacity)},${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,${scaleY},${s.letterSpacing * scale},0,4,0,${3 * scale},${alignment},0,0,0,1`);
      for (const frame of frames) events.push(`Dialogue: ${index * 2},${stamp(frame.start)},${stamp(frame.end)},${backgroundName},,0,0,0,,{\\q2\\pos(${x.toFixed(3)},${(height - bottom + frame.y * scale).toFixed(3)})\\fscx${100 * frame.scale}\\fscy${scaleY * frame.scale}\\4a&H${Math.round(255 * (1 - s.backgroundOpacity / 100 * frame.opacity)).toString(16).padStart(2, '0')}&}${literal(text)}`);
    }
    const rows = text.split("\n");
    let offset = 0, wordOffset = 0;
    rows.forEach((row, line) => {
      // Explicit baselines match CSS line-height after its font metrics override.
      const y = height - bottom - (rows.length - 1 - line) * fontSize * TEXT_LINE_HEIGHT
        + fontSize * (metrics.ascent + metrics.descent - TEXT_LINE_HEIGHT) / 2;
      for (const frame of frames) {
        const animatedY = height - bottom + (y - (height - bottom)) * frame.scale + frame.y * scale;
        events.push(`Dialogue: ${index * 2 + 1},${stamp(frame.start)},${stamp(frame.end)},${name},,0,0,0,,{\\q2\\pos(${x.toFixed(3)},${animatedY.toFixed(3)})\\fscx${100 * frame.scale}\\fscy${100 * frame.scale}${assOpacity(frame.opacity)}}${s.animation === 'none' ? literal(row) : animatedAssText(row, { ...s, background: 'none' }, frame, offset, wordOffset)}`);
      }
      offset += Array.from(row).length + 1;
      wordOffset += row.split(/\s+/u).filter(Boolean).length;
    });
  }
  return ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "ScaledBorderAndShadow: yes", "YCbCr Matrix: None", "WrapStyle: 2", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding", ...styles, "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, ""].join("\n");
}
