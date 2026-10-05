import { captionLines, captionWordStarts, resolveCaptionStyle, type CaptionStyle } from "../shared/caption-style.js";
import type { TranscriptWord } from "../shared/types.js";

export interface TimedCaption { start: number; end: number; text: string }

/**
 * The script canvas and base style FFmpeg gives converted SRT files. The same
 * force_style is applied on top, so fonts, sizes and placement match SRT captions.
 */
const HEADER = [
  "[Script Info]", "ScriptType: v4.00+", "PlayResX: 384", "PlayResY: 288", "ScaledBorderAndShadow: yes", "YCbCr Matrix: None", "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0", "",
  "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
];
const centiseconds = (seconds: number) => Math.max(0, Math.round(seconds * 100));
const stamp = (value: number) => `${Math.floor(value / 360_000)}:${String(Math.floor(value / 6000) % 60).padStart(2, "0")}:${String(Math.floor(value / 100) % 60).padStart(2, "0")}.${String(value % 100).padStart(2, "0")}`;
/** Caption words stay text: braces would open override blocks and a backslash could start \N. */
const literal = (word: string) => word.replace(/\\/gu, "\\​").replace(/\{/gu, "(").replace(/\}/gu, ")");
/** Inline ASS colors are &HBBGGRR&. Style colors were validated as six-digit hex. */
const inlineColor = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();

/** Read the app's canonical SRT output: numeric header, timestamp line, then text. */
export function parseCanonicalSrt(srt: string): TimedCaption[] {
  const seconds = (value: string) => { const [h, m, s] = value.replace(",", ".").split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
  return srt.trim().split(/\n\n+/u).flatMap(block => {
    const [, timing, ...text] = block.split("\n");
    const match = /^(\S+) --> (\S+)$/u.exec(timing?.trim() || "");
    return match && text.length ? [{ start: seconds(match[1]!), end: seconds(match[2]!), text: text.join("\n") }] : [];
  });
}

/**
 * One event per spoken word, each drawing the whole caption with that word in
 * the highlight color. Events abut exactly, so the caption never flickers.
 */
export function captionsAss(captions: TimedCaption[], style: CaptionStyle | undefined, words: TranscriptWord[] = []): string {
  const s = resolveCaptionStyle(style);
  const events: string[] = [];
  const dialogue = (from: number, to: number, text: string) => events.push(`Dialogue: 0,${stamp(from)},${stamp(to)},Default,,0,0,0,,${text}`);
  for (const caption of captions) {
    const rows = captionLines(caption.text.replace(/\r/gu, ""));
    const count = rows.flat().length;
    const begin = centiseconds(caption.start), finish = centiseconds(caption.end);
    if (!count || finish <= begin) continue;
    const draw = (active: number) => {
      let index = 0;
      return rows.map(row => row.map(word => index++ === active
        ? `{\\1c${inlineColor(s.highlightColor)}}${literal(word)}{\\r}` : literal(word)).join(" ")).join("\\N");
    };
    if (!s.wordHighlight) { dialogue(begin, finish, draw(-1)); continue; }
    const starts = captionWordStarts(caption.text, caption.start, caption.end, words).map(centiseconds);
    for (let index = 0; index < count; index++) {
      const from = index ? Math.max(begin, starts[index]!) : begin;
      const to = index + 1 < count ? Math.min(finish, starts[index + 1]!) : finish;
      if (to > from) dialogue(from, to, draw(index));
    }
  }
  return `${[...HEADER, ...events].join("\n")}\n`;
}
