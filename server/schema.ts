import { z } from "zod";
import { DEFAULT_SETTINGS } from "../shared/types.js";
const n = (min: number, max: number) => z.number().finite().min(min).max(max);
export const settingsSchema = z
  .object({
    speed: n(0.5, 2),
    volume: n(0, 2),
    muted: z.boolean(),
    zoom: n(1, 2),
    saturation: n(0, 3),
    brightness: n(-1, 1),
    contrast: n(0, 2),
    hue: n(-180, 180),
    gamma: n(0.1, 3),
    temperature: n(-1, 1),
    noise: n(0, 1),
    sharpness: n(0, 2),
    blend: n(0, 1),
    frameBlend: n(0, 0.5),
    timeShift: n(-5, 5),
    mirror: z.boolean(),
    aspect: z.enum(["original", "9:16", "1:1", "4:5", "16:9"]),
    fit: z.enum(["crop", "contain"]),
    resolution: z.enum(["source", "720", "1080"]),
    fps: z.enum(["source", "24", "30", "60"]),
    trimStart: n(0, 86400),
    trimEnd: n(0.01, 86400).nullable(),
    hookText: z.string().max(200),
    hookDuration: n(0.5, 30),
    stripMetadata: z.boolean(),
    device: z
      .string()
      .max(60)
      .regex(/^[\p{L}\p{N} .()_-]*$/u),
    audioId: z.string().uuid().nullable(),
    subtitleId: z.string().uuid().nullable(),
  })
  .strict();
export const batchSchema = z
  .object({
    items: z
      .array(
        z.object({ sourceId: z.string().uuid(), settings: settingsSchema }),
      )
      .min(1)
      .max(100),
    variants: z.number().int().min(1).max(5).default(1),
    randomize: z.boolean().default(false),
  })
  .strict();
export const normalizedSettings = (input: unknown) =>
  settingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...(typeof input === "object" && input ? input : {}),
  });
