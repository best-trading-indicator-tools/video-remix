import { z } from "zod";
import { DEFAULT_SETTINGS, MAX_AUTO_VERSIONS, MAX_BROLL_COUNT } from "../shared/types.js";
const n = (min: number, max: number) => z.number().finite().min(min).max(max);
export const focalPointSchema = z.object({ x: n(0, 1), y: n(0, 1) }).strict();
export const captionStyleSchema = z.object({ fontSize: n(12, 40), bottomPercent: n(5, 80) }).strict();
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
    fit: z.enum(["crop", "contain", "blur"]),
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
      .regex(/^[\p{L}\p{N} .()_-]*$/u)
      .transform(() => "none"),
    audioId: z.string().uuid().nullable(),
    subtitleId: z.string().uuid().nullable(),
    segments: z
      .array(
        z
          .object({ start: n(0, 86400), end: n(0, 86400), focalPoint: focalPointSchema.optional() })
          .refine(
            (value) => value.end > value.start + 0.04,
            "Cut end must follow its start",
          ),
      )
      .min(1)
      .max(60)
      .optional(),
    callouts: z
      .array(
        z
          .object({
            text: z.string().max(120),
            start: n(0, 172800),
            end: n(0, 172800),
          })
          .refine(
            (value) => value.end > value.start,
            "Callout end must follow its start",
          ),
      )
      .max(5)
      .optional(),
    normalizeAudio: z.boolean().optional(),
    qualityCleanup: z.boolean().optional(),
    autoMotion: z.boolean().optional(),
    focalPoint: focalPointSchema.optional(),
    captionStyle: captionStyleSchema.optional(),
  })
  .strict();
export const batchSchema = z
  .object({
    items: z
      .array(
        z.object({ sourceId: z.string().uuid(), settings: settingsSchema,
          title: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/u.test(value), "Use a title without control characters").optional() }),
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
export const autoOptionsSchema = z
  .object({
    aspect: z.enum(["original", "9:16", "1:1", "4:5", "16:9"]).default("9:16"),
    targetDuration: z
      .union([z.literal(30), z.literal(45), z.literal(60)])
      .default(45),
    narration: z.boolean().default(false),
    supportingVisuals: z
      .enum(["off", "stock", "library", "graphics", "both"])
      .optional(),
    brollIds: z.array(z.string().uuid()).max(100).optional(),
    brollMatching: z.enum(["tags", "ai"]).optional(),
    brollCount: z.number().int().min(1).max(MAX_BROLL_COUNT).optional(),
    editorialMode: z.enum(["off", "check", "repair"]).optional(),
    stockVideoType: z.enum(["all", "animation"]).optional(),
  })
  .strict()
  .default({ aspect: "9:16", targetDuration: 45, narration: false });
const autoVariantsSchema = z.number().int().min(1).max(MAX_AUTO_VERSIONS).default(1);
const autoItemsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            sourceId: z.string().uuid(),
            variants: autoVariantsSchema,
            options: autoOptionsSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (items) =>
          new Set(items.map((item) => item.sourceId)).size === items.length,
        "Choose each source video only once in an automatic batch.",
      ),
  })
  .strict();
const legacyAutoBatchSchema = z
  .object({
    sourceIds: z.array(z.string().uuid()).min(1).max(100),
    variants: autoVariantsSchema,
    options: autoOptionsSchema,
  })
  .strict()
  .transform(({ sourceIds, variants, options }) => ({
    items: [...new Set(sourceIds)].map((sourceId) => ({
      sourceId,
      variants,
      options,
    })),
  }));
export const autoBatchSchema = z.union([
  autoItemsSchema,
  legacyAutoBatchSchema,
]);
