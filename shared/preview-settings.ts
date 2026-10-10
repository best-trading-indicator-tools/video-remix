import { DEFAULT_SETTINGS, type AutoOptions, type RemixSettings } from "./types.js";

/** The Auto picture preview is local: never run paid planning or generate captions. */
export function autoPicturePreview(options: AutoOptions, source?: { width: number; height: number }): RemixSettings {
  const aspect = options.aspect === "original" ? source ? source.width / source.height : 16 / 9
    : Number(options.aspect.split(":")[0]) / Number(options.aspect.split(":")[1]);
  const sourceAspect = source ? source.width / source.height : aspect;
  return {
    ...DEFAULT_SETTINGS, aspect: options.aspect,
    fit: options.blackBands?.enabled ? options.blackBands.fit : Math.abs(sourceAspect - aspect) > 0.12 ? "blur" : "crop",
    upscale: options.upscale, watermarkRemoval: options.watermarkRemoval,
    blackBands: options.blackBands, ownFootage: options.ownFootage, ownFootageSourceId: options.ownFootageSourceId,
    captionStyle: options.captionStyle,
  };
}
