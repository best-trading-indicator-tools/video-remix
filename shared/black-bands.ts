import { z } from "zod";
import { wrapEditorialText } from "./text-wrap.js";
import { cyrillicLookalikes } from "./caption-text.js";

const text = z.string().max(200).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Use printable text");
const fontPercent = z.number().finite().min(3).max(10);
export const bandTextStyleSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
  fontPercent: fontPercent.optional(),
  cyrillic: z.boolean().optional(),
}).strict();
export type BandTextStyle = z.infer<typeof bandTextStyleSchema>;
export type BandSide = "top" | "bottom";
export const blackBandsSchema = z.object({
  enabled: z.boolean(),
  fit: z.enum(["contain", "crop"]),
  topPercent: z.number().finite().min(10).max(40),
  bottomPercent: z.number().finite().min(10).max(40),
  topText: text,
  bottomText: text,
  fontPercent,
  topStyle: bandTextStyleSchema.optional(),
  bottomStyle: bandTextStyleSchema.optional(),
}).strict().refine(value => value.topPercent + value.bottomPercent <= 70, "Leave at least 30% of the canvas for video");

export type BlackBands = z.infer<typeof blackBandsSchema>;
export const DEFAULT_BLACK_BANDS: BlackBands = {
  enabled: false, fit: "contain", topPercent: 25, bottomPercent: 15,
  topText: "", bottomText: "", fontPercent: 5.4,
};

export const blackBandsPatchSchema = z.object(blackBandsSchema.shape).partial().strict();
export function applyBlackBandsPatch(current: BlackBands | undefined, patch: z.infer<typeof blackBandsPatchSchema>): BlackBands {
  return blackBandsSchema.parse({
    ...DEFAULT_BLACK_BANDS, ...current, ...patch,
    ...(patch.topStyle ? { topStyle: { ...current?.topStyle, ...patch.topStyle } } : {}),
    ...(patch.bottomStyle ? { bottomStyle: { ...current?.bottomStyle, ...patch.bottomStyle } } : {}),
  });
}

/** Original words stay editable; substitutions are shared by preview and export. */
export function bandTextAppearance(bands: BlackBands, side: BandSide) {
  const style = bands[`${side}Style`];
  const original = bands[`${side}Text`];
  return {
    text: style?.cyrillic ? cyrillicLookalikes(original) : original,
    color: style?.color ?? "#ffffff",
    fontPercent: style?.fontPercent ?? bands.fontPercent,
    cyrillic: style?.cyrillic ?? false,
  };
}

export function blackBandChangeSummary(before: BlackBands | undefined, after: BlackBands): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!after.enabled) return ["Black bands: off."];
  const summary = [`Black bands: top ${after.topPercent}%, bottom ${after.bottomPercent}%, ${after.fit === "contain" ? "keep the whole picture" : "fill the window"}.`];
  for (const side of ["top", "bottom"] as const) {
    const appearance = bandTextAppearance(after, side);
    if (before?.enabled && JSON.stringify(bandTextAppearance(before, side)) === JSON.stringify(appearance)) continue;
    const color = appearance.color.toLowerCase() === "#ffffff" ? "white" : appearance.color;
    const size = appearance.fontPercent === 5.4 ? "medium (5.4%)" : `${appearance.fontPercent}%`;
    summary.push(`${side === "top" ? "Top" : "Bottom"} band text: ${appearance.text ? `“${appearance.text}” · ${color} · ${size}${appearance.cyrillic ? " · Cyrillic lookalikes" : ""}` : "none"}.`);
  }
  return summary;
}

/** Even dimensions keep the picture and padding aligned on the encoded pixel grid. */
export function blackBandGeometry(width: number, height: number, bands?: BlackBands) {
  const top = bands?.enabled ? Math.floor(height * bands.topPercent / 200) * 2 : 0;
  const bottom = bands?.enabled ? Math.floor(height * bands.bottomPercent / 200) * 2 : 0;
  return { width, height: height - top - bottom, top, bottom, canvasHeight: height };
}

/** Shared conservative wrapping for the preview and export, including long words. */
export function bandTextLayout(text: string, width: number, height: number, bandHeight: number, fontPercent: number) {
  let size = Math.max(1, Math.min(width, height) * fontPercent / 100);
  let wrapped = "";
  for (let attempt = 0; attempt < 80; attempt++) {
    wrapped = wrapEditorialText(text.trim(), Math.max(1, Math.floor(width * 0.9 / size)));
    const textHeight = wrapped.split("\n").length * size * 1.25;
    if (textHeight <= bandHeight * 0.8) break;
    size *= Math.min(0.94, bandHeight * 0.8 / textHeight);
  }
  return { text: wrapped, fontSize: size };
}

/** Presets copy the finish while each video's written text stays with that video. */
export const blackBandFinishSchema = z.object({
  enabled: z.boolean(), fit: z.enum(["contain", "crop"]),
  topPercent: z.number().min(10).max(40), bottomPercent: z.number().min(10).max(40),
  fontPercent: z.number().min(3).max(10),
  topStyle: bandTextStyleSchema.optional(),
  bottomStyle: bandTextStyleSchema.optional(),
}).refine(value => value.topPercent + value.bottomPercent <= 70);

export function applyBandFinish(current: BlackBands | undefined, finish: z.infer<typeof blackBandFinishSchema> | undefined): BlackBands | undefined {
  return finish ? { ...DEFAULT_BLACK_BANDS, ...current, ...finish } : current;
}
