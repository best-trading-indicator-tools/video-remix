import { z } from "zod";
import { wrapEditorialText } from "./text-wrap.js";

const text = z.string().max(200).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Use printable text");
export const blackBandsSchema = z.object({
  enabled: z.boolean(),
  fit: z.enum(["contain", "crop"]),
  topPercent: z.number().finite().min(10).max(40),
  bottomPercent: z.number().finite().min(10).max(40),
  topText: text,
  bottomText: text,
  fontPercent: z.number().finite().min(3).max(10),
}).strict().refine(value => value.topPercent + value.bottomPercent <= 70, "Leave at least 30% of the canvas for video");

export type BlackBands = z.infer<typeof blackBandsSchema>;
export const DEFAULT_BLACK_BANDS: BlackBands = {
  enabled: false, fit: "contain", topPercent: 25, bottomPercent: 15,
  topText: "", bottomText: "", fontPercent: 5.4,
};

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
}).refine(value => value.topPercent + value.bottomPercent <= 70);

export function applyBandFinish(current: BlackBands | undefined, finish: z.infer<typeof blackBandFinishSchema> | undefined): BlackBands | undefined {
  return finish ? { ...DEFAULT_BLACK_BANDS, ...current, ...finish } : current;
}
