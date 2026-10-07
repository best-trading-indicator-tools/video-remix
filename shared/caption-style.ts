import { z } from "zod";

export const CAPTION_FONTS = {
  classic: { label: "Classic sans", family: "DejaVu Sans", css: '"DejaVu Sans", Arial, sans-serif' },
  "tiktok-sans": { label: "TikTok Sans", family: "TikTok Sans 16pt", css: '"Caption TikTok Sans", sans-serif' },
  poppins: { label: "Poppins · clean", family: "Poppins", css: '"Caption Poppins", sans-serif' },
  anton: { label: "Anton · punchy", family: "Anton", css: '"Caption Anton", sans-serif' },
  serif: { label: "DM Serif · editorial", family: "DM Serif Display", css: '"Caption Serif", serif' },
} as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/u, "Use a six-digit hex color");
/** New fields are optional so existing exports and saved presets retain their appearance. */
export const captionStyleSchema = z.object({
  fontSize: z.number().finite().min(12).max(40),
  bottomPercent: z.number().finite().min(5).max(80),
  fontFamily: z.enum(["classic", "tiktok-sans", "poppins", "anton", "serif"]).optional(),
  color: color.optional(), bold: z.boolean().optional(), italic: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  outlineWidth: z.number().finite().min(0).max(5).optional(), outlineColor: color.optional(),
  shadow: z.number().finite().min(0).max(5).optional(),
  letterSpacing: z.number().finite().min(0).max(4).optional(),
  alignment: z.enum(["left", "center", "right"]).optional(),
  background: z.enum(["none", "box"]).optional(), backgroundColor: color.optional(),
  backgroundOpacity: z.number().finite().min(0).max(100).optional(),
  /** Light up each word while it is spoken. Off for every existing export and preset. */
  wordHighlight: z.boolean().optional(), highlightColor: color.optional(),
}).strict();
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export const DEFAULT_CAPTION_STYLE: Required<CaptionStyle> = {
  fontSize: 20, bottomPercent: 100 / 12, fontFamily: "classic", color: "#ffffff",
  bold: false, italic: false, uppercase: false, outlineWidth: 2, outlineColor: "#151515",
  shadow: 0, letterSpacing: 0, alignment: "center", background: "none", backgroundColor: "#10151c", backgroundOpacity: 80,
  wordHighlight: false, highlightColor: "#ffe14d",
};
/** Looks change the lettering only; the word highlight choice is kept separately. */
export type CaptionLook = Omit<CaptionStyle, "wordHighlight" | "highlightColor">;
const { wordHighlight: _wordHighlight, highlightColor: _highlightColor, ...LOOK_BASE } = DEFAULT_CAPTION_STYLE;
export const withoutHighlight = ({ wordHighlight: _on, highlightColor: _color, ...look }: CaptionStyle): CaptionLook => look;
export const resolveCaptionStyle = (style?: CaptionStyle): Required<CaptionStyle> => ({ ...DEFAULT_CAPTION_STYLE, ...style });
export function captionStyleDescription(style?: CaptionStyle): string {
  const s = resolveCaptionStyle(style);
  return `Caption look: ${CAPTION_FONTS[s.fontFamily].family}, ${s.color}, ${s.bold ? "bold" : "regular"}${s.italic ? ", italic" : ""}${s.uppercase ? ", uppercase" : ""}, ${s.alignment} aligned; ${s.background === "box" ? `${s.backgroundColor} box at ${s.backgroundOpacity}% opacity` : `${s.outlineColor} outline at ${s.outlineWidth}`}; shadow ${s.shadow}, spacing ${s.letterSpacing}${s.wordHighlight ? `; each spoken word highlighted in ${s.highlightColor}` : ""}.`;
}
/** A highlight that stays visible against the chosen text color. */
export function contrastingHighlight(textColor: string): string {
  const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const [a, b] = [rgb(textColor), rgb(DEFAULT_CAPTION_STYLE.highlightColor)];
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 120 ? "#5ee87d" : DEFAULT_CAPTION_STYLE.highlightColor;
}
export const CAPTION_PRESETS: { id: string; name: string; description: string; style: CaptionLook }[] = [
  { id: "clean", name: "Clean", description: "Crisp, everyday captions", style: { ...LOOK_BASE, fontFamily: "poppins", bold: true, fontSize: 20, outlineWidth: 1.2, shadow: 0.8, bottomPercent: 18 } },
  { id: "punch", name: "Punch", description: "Big type, bright yellow", style: { ...LOOK_BASE, fontFamily: "anton", fontSize: 24, color: "#ffe66d", uppercase: true, outlineWidth: 1.5, bottomPercent: 18 } },
  { id: "editorial", name: "Editorial", description: "A softer, magazine feel", style: { ...LOOK_BASE, fontFamily: "serif", fontSize: 22, color: "#fff1dc", outlineWidth: 0.7, shadow: 1, bottomPercent: 18 } },
  { id: "box", name: "Box", description: "Readable over busy footage", style: { ...LOOK_BASE, fontFamily: "poppins", fontSize: 19, bold: true, background: "box", bottomPercent: 18 } },
];

/** ASS uses alpha-BGR, with zero alpha meaning opaque. Inputs are validated before interpolation. */
export function assColor(hex: string, opacity = 100): string {
  const alpha = Math.round(255 * (1 - opacity / 100)).toString(16).padStart(2, "0");
  return `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
}
export function captionAssStyle(style?: CaptionStyle): string {
  const s = resolveCaptionStyle(style === undefined ? undefined : captionStyleSchema.parse(style));
  return [
    `FontName=${CAPTION_FONTS[s.fontFamily].family}`, `FontSize=${s.fontSize}`,
    `PrimaryColour=${assColor(s.color)}`, `Bold=${s.bold ? -1 : 0}`, `Italic=${s.italic ? -1 : 0}`,
    `Spacing=${s.letterSpacing}`, `OutlineColour=${assColor(s.background === "box" ? s.backgroundColor : s.outlineColor, s.background === "box" ? s.backgroundOpacity : 100)}`,
    "BackColour=&H00000000", `BorderStyle=${s.background === "box" ? 3 : 1}`,
    `Outline=${s.background === "box" ? 3 : s.outlineWidth}`, `Shadow=${s.shadow}`,
    `Alignment=${{ left: 1, center: 2, right: 3 }[s.alignment]}`,
    `MarginV=${Math.round(s.bottomPercent * 288 / 100)}`,
  ].join(",");
}

/** Words of a caption, line by line, exactly as they will be drawn. */
export const captionLines = (text: string) => text.split("\n").map(line => line.split(/\s+/u).filter(Boolean));

/**
 * Start time of each word in a caption. Recognized word timings are used when
 * they match the caption's words one to one; otherwise, as after a wording
 * correction or for an uploaded SRT, the caption's span is shared by word length.
 */
export function captionWordStarts(text: string, start: number, end: number, words: { start: number; end: number; word: string }[] = []): number[] {
  const tokens = captionLines(text).flat();
  if (!tokens.length || !(end > start)) return tokens.map(() => start);
  const spoken = words.filter(word => word.word.trim() && (word.start + word.end) / 2 >= start - 0.05 && (word.start + word.end) / 2 <= end + 0.05);
  const normalize = (word: string) => word.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (spoken.length === tokens.length && spoken.every((word, index) => normalize(word.word) === normalize(tokens[index]!))) {
    let previous = start;
    return spoken.map((word, index) => (previous = index ? Math.min(end, Math.max(previous, word.start)) : start));
  }
  const weights = tokens.map(token => token.length + 2), total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return weights.map(weight => { const at = start + (end - start) * elapsed / total; elapsed += weight; return at; });
}
