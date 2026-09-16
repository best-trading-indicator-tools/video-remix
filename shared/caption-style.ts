import { z } from "zod";

export const CAPTION_FONTS = {
  classic: { label: "Classic sans", family: "DejaVu Sans", css: '"DejaVu Sans", Arial, sans-serif' },
  poppins: { label: "Poppins · clean", family: "Poppins", css: '"Caption Poppins", sans-serif' },
  anton: { label: "Anton · punchy", family: "Anton", css: '"Caption Anton", sans-serif' },
  serif: { label: "DM Serif · editorial", family: "DM Serif Display", css: '"Caption Serif", serif' },
} as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/u, "Use a six-digit hex color");
/** New fields are optional so existing exports and saved presets retain their appearance. */
export const captionStyleSchema = z.object({
  fontSize: z.number().finite().min(12).max(40),
  bottomPercent: z.number().finite().min(5).max(80),
  fontFamily: z.enum(["classic", "poppins", "anton", "serif"]).optional(),
  color: color.optional(), bold: z.boolean().optional(), italic: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  outlineWidth: z.number().finite().min(0).max(5).optional(), outlineColor: color.optional(),
  shadow: z.number().finite().min(0).max(5).optional(),
  letterSpacing: z.number().finite().min(0).max(4).optional(),
  alignment: z.enum(["left", "center", "right"]).optional(),
  background: z.enum(["none", "box"]).optional(), backgroundColor: color.optional(),
  backgroundOpacity: z.number().finite().min(0).max(100).optional(),
}).strict();
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export const DEFAULT_CAPTION_STYLE: Required<CaptionStyle> = {
  fontSize: 20, bottomPercent: 100 / 12, fontFamily: "classic", color: "#ffffff",
  bold: false, italic: false, uppercase: false, outlineWidth: 2, outlineColor: "#151515",
  shadow: 0, letterSpacing: 0, alignment: "center", background: "none", backgroundColor: "#10151c", backgroundOpacity: 80,
};
export const resolveCaptionStyle = (style?: CaptionStyle): Required<CaptionStyle> => ({ ...DEFAULT_CAPTION_STYLE, ...style });
export function captionStyleDescription(style?: CaptionStyle): string {
  const s = resolveCaptionStyle(style);
  return `Caption look: ${CAPTION_FONTS[s.fontFamily].family}, ${s.color}, ${s.bold ? "bold" : "regular"}${s.italic ? ", italic" : ""}${s.uppercase ? ", uppercase" : ""}, ${s.alignment} aligned; ${s.background === "box" ? `${s.backgroundColor} box at ${s.backgroundOpacity}% opacity` : `${s.outlineColor} outline at ${s.outlineWidth}`}; shadow ${s.shadow}, spacing ${s.letterSpacing}.`;
}
export const CAPTION_PRESETS: { id: string; name: string; description: string; style: CaptionStyle }[] = [
  { id: "clean", name: "Clean", description: "Crisp, everyday captions", style: { ...DEFAULT_CAPTION_STYLE, fontFamily: "poppins", bold: true, fontSize: 20, outlineWidth: 1.2, shadow: 0.8, bottomPercent: 18 } },
  { id: "punch", name: "Punch", description: "Big type, bright yellow", style: { ...DEFAULT_CAPTION_STYLE, fontFamily: "anton", fontSize: 24, color: "#ffe66d", uppercase: true, outlineWidth: 1.5, bottomPercent: 18 } },
  { id: "editorial", name: "Editorial", description: "A softer, magazine feel", style: { ...DEFAULT_CAPTION_STYLE, fontFamily: "serif", fontSize: 22, color: "#fff1dc", outlineWidth: 0.7, shadow: 1, bottomPercent: 18 } },
  { id: "box", name: "Box", description: "Readable over busy footage", style: { ...DEFAULT_CAPTION_STYLE, fontFamily: "poppins", fontSize: 19, bold: true, background: "box", bottomPercent: 18 } },
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
