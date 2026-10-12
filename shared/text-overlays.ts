import { z } from "zod";
import { captionStyleSchema, DEFAULT_CAPTION_STYLE, resolveCaptionStyle } from "./caption-style.js";
import { captionDisplayText } from "./caption-text.js";
import { wrapEditorialText } from "./text-wrap.js";

// Bundled font OS/2 Windows ascender/descender metrics in em units. ASS sizes use
// their sum; CSS sizes use the em square. Keep preview and libass in agreement.
export const TEXT_FONT_METRICS = {
  poppins: { ascent: 1.135, descent: .627, css: '"Overlay Poppins"' },
  anton: { ascent: 2876 / 2048, descent: 674 / 2048, css: '"Overlay Anton"' },
  "tiktok-sans": { ascent: 1.118, descent: .242, css: '"Overlay TikTok Sans"' },
  serif: { ascent: 1.036, descent: .335, css: '"Overlay Serif"' },
} as const;
export const TEXT_LINE_HEIGHT = 1.2;
export const MAX_TEXT_OVERLAYS = 20;
/** Times are on the finished output, including inserted footage. They stay fixed when cuts change. */
export const textOverlaySchema = z.object({
  id: z.string().uuid(),
  text: z.string().max(500).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Use printable text"),
  start: z.number().finite().min(0).max(86400),
  end: z.number().finite().min(0).max(86400),
  xPercent: z.number().finite().min(5).max(95),
  widthPercent: z.number().finite().min(10).max(90),
  style: captionStyleSchema,
}).strict().refine(item => item.end - item.start >= 0.04 - 1e-9, "Text must stay visible for at least 0.04 seconds");
export const textOverlaysSchema = z.array(textOverlaySchema).max(MAX_TEXT_OVERLAYS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, "Text IDs must be unique");
export type TextOverlay = z.infer<typeof textOverlaySchema>;
export const newTextOverlay = (id: string, start = 0, end = start + 3): TextOverlay => ({
  id, text: "Your text", start, end, xPercent: 50, widthPercent: 80,
  style: { ...DEFAULT_CAPTION_STYLE, fontFamily: "poppins", bold: true, bottomPercent: 45 },
});

/** Preview and export use the same explicit line breaks and safe horizontal bounds. */
export function textOverlayLayout(item: TextOverlay, width: number, height: number) {
  const style = resolveCaptionStyle(item.style), scale = height / 288;
  // Free text uses bundled fonts even on desktops without system DejaVu Sans.
  if (style.fontFamily === "classic") style.fontFamily = "poppins";
  const boxWidth = width * Math.min(item.widthPercent, 2 * Math.min(item.xPercent, 100 - item.xPercent)) / 100;
  const columns = Math.max(1, Math.floor((boxWidth - 6 * scale) / ((style.fontSize * .7 + style.letterSpacing) * scale)));
  const text = wrapEditorialText(captionDisplayText(item.text, style), columns);
  const left = width * item.xPercent / 100 - boxWidth / 2;
  return { text, left, width: boxWidth, bottom: height * style.bottomPercent / 100, style, metrics: TEXT_FONT_METRICS[style.fontFamily] };
}
