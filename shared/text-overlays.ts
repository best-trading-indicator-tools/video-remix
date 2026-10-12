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

export const TITLE_DESIGNS = [
  { id: 'bold', name: 'Bold hook', sample: 'STOP SCROLLING', style: { fontFamily: 'anton', fontSize: 30, uppercase: true, color: '#ffe66d', bottomPercent: 65, animation: 'pop', outlineWidth: 1.5 } },
  { id: 'editorial', name: 'Editorial', sample: 'A different perspective', style: { fontFamily: 'serif', fontSize: 27, color: '#fff1dc', bottomPercent: 55, animation: 'fade', shadow: 1, outlineWidth: .5 } },
  { id: 'label', name: 'Lower third', sample: 'YOUR NAME · YOUR STORY', style: { fontFamily: 'poppins', fontSize: 18, bold: true, color: '#ffffff', alignment: 'left', background: 'box', backgroundColor: '#10151c', bottomPercent: 22, animation: 'slide' } },
  { id: 'announcement', name: 'Announcement', sample: 'Something new is here', style: { fontFamily: 'tiktok-sans', fontSize: 26, bold: true, background: 'box', backgroundColor: '#f5dcac', color: '#171717', backgroundOpacity: 100, bottomPercent: 45, animation: 'typewriter' } },
] as const;
export function titleOverlay(id: string, design: typeof TITLE_DESIGNS[number]['id'], text: string, start = 0, end = start + 3): TextOverlay {
  const preset = TITLE_DESIGNS.find(item => item.id === design)!;
  const base = newTextOverlay(id, start, end);
  return { ...base, text, style: { ...base.style, ...preset.style } };
}

/** Resize around the existing anchor, independent of preview dimensions. */
export function resizeTextOverlay(from: { fontSize: number; widthPercent: number }, dx: number, dy: number, boxWidth: number, boxHeight: number) {
  if (![dx, dy, boxWidth, boxHeight].every(Number.isFinite) || boxWidth <= 0 || boxHeight <= 0) return from;
  const factor = Math.max(.1, 1 + (Math.abs(dx / boxWidth) > Math.abs(dy / boxHeight) ? dx / boxWidth : dy / boxHeight));
  const round = (n: number) => Math.round(n * 100) / 100;
  return { fontSize: round(Math.min(40, Math.max(12, from.fontSize * factor))), widthPercent: round(Math.min(90, Math.max(10, from.widthPercent * factor))) };
}

export type TextOverlayPosition = { xPercent: number; bottomPercent: number };
/** Pointer distances use the displayed canvas size, independent of export resolution. */
export function moveTextOverlay(from: TextOverlayPosition, dx: number, dy: number, width: number, height: number): TextOverlayPosition {
  if (![dx, dy, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return from;
  const bound = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)) * 100) / 100;
  return { xPercent: bound(from.xPercent + dx / width * 100, 5, 95), bottomPercent: bound(from.bottomPercent - dy / height * 100, 5, 80) };
}

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
