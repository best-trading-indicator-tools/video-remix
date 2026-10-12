import { assColor, CAPTION_FONTS } from "../shared/caption-style.js";
import { textOverlayLayout, textOverlaysSchema, TEXT_LINE_HEIGHT, type TextOverlay } from "../shared/text-overlays.js";

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
    styles.push(`Style: ${name},${CAPTION_FONTS[s.fontFamily].family},${assSize},${assColor(s.color)},${assColor(s.color)},${assColor(box ? s.backgroundColor : s.outlineColor, box ? s.backgroundOpacity : 100)},&H00000000,${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,100,${s.letterSpacing * scale},0,${box ? 3 : 1},${(box ? 3 : s.outlineWidth) * scale},${s.shadow * scale},${alignment},0,0,0,1`);
    const rows = text.split("\n");
    rows.forEach((row, line) => {
      // Explicit baselines match CSS line-height after its font metrics override.
      const y = height - bottom - (rows.length - 1 - line) * fontSize * TEXT_LINE_HEIGHT
        + fontSize * (metrics.ascent + metrics.descent - TEXT_LINE_HEIGHT) / 2;
      events.push(`Dialogue: ${index},${stamp(item.start)},${stamp(Math.min(item.end, duration))},${name},,0,0,0,,{\\q2\\pos(${x.toFixed(3)},${y.toFixed(3)})}${literal(row)}`);
    });
  }
  return ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${width}`, `PlayResY: ${height}`, "ScaledBorderAndShadow: yes", "YCbCr Matrix: None", "WrapStyle: 2", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding", ...styles, "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...events, ""].join("\n");
}
