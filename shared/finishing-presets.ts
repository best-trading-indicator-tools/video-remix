import { NATURAL_PACING, pacingOptionsSchema } from "./pacing.js";
import { z } from "zod";
import { DEFAULT_SETTINGS, DEFAULT_BROLL_COUNT, DEFAULT_BROLL_MAX_COVERAGE } from "./types.js";
import { getVisualSources } from "./visual-sources.js";
import type { AutoOptions } from "./types.js";
export const FINISHING_PRESET_STORAGE = "remix-finishing-presets-v1";
export const FINISHING_PRESET_EVENT = "remix-finishing-presets-changed";
const aspect = z.enum(["original", "9:16", "1:1", "4:5", "16:9"]);
const framing = {
  aspect, fit: z.enum(["crop", "contain", "blur"]), resolution: z.enum(["source", "720", "1080"]),
  zoom: z.number().min(1).max(2), layout: z.enum(["single", "split", "presentation"]).default("single"),
  normalizeAudio: z.boolean().default(false), qualityCleanup: z.boolean().default(false),
};
const autoSchema = z.object({ aspect, pacing: pacingOptionsSchema.default(NATURAL_PACING), captions: z.enum(["auto", "add", "keep"]).default("auto"),
  visualSources: z.array(z.enum(["pixabay", "pexels", "hyperframes", "remotion", "library"])).max(5).transform(values => [...new Set(values)]),
  brollCount: z.number().int().min(1).max(10).default(DEFAULT_BROLL_COUNT),
  brollMaxCoverage: z.number().int().min(0).max(100).default(DEFAULT_BROLL_MAX_COVERAGE),
  brollMatching: z.enum(["tags", "ai"]).default("tags"), stockVideoType: z.enum(["all", "animation"]).default("all"),
});
const shortSchema = z.object({ ...framing, autoFocus: z.boolean().default(false), focusMode: z.enum(["face", "speaker"]).default("face") });
const manualSchema = z.object({ ...framing, fps: z.enum(["source", "24", "30", "60"]),
  saturation: z.number().min(0).max(3), brightness: z.number().min(-1).max(1), contrast: z.number().min(0).max(2),
  hue: z.number().min(-180).max(180), gamma: z.number().min(0.1).max(3), temperature: z.number().min(-1).max(1),
  noise: z.number().min(0).max(1), sharpness: z.number().min(0).max(2), blend: z.number().min(0).max(1), frameBlend: z.number().min(0).max(0.5),
  volume: z.number().min(0).max(2), muted: z.boolean(), mirror: z.boolean(), autoMotion: z.boolean().default(false),
  captionStyle: z.object({ fontSize: z.number().min(12).max(40), bottomPercent: z.number().min(5).max(80) }).default({fontSize:20,bottomPercent:100/12}),
});
const base = { id: z.string().min(1).max(100), name: z.string().trim().min(1).max(60).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)) };
const schema = z.discriminatedUnion("mode", [
  z.object({ ...base, mode: z.literal("auto"), settings: autoSchema }),
  z.object({ ...base, mode: z.literal("manual"), settings: manualSchema }),
  z.object({ ...base, mode: z.literal("shorts"), settings: shortSchema }),
]);
export type FinishingPreset = z.infer<typeof schema>;
export type PresetMode = FinishingPreset["mode"];
export type PresetValues = { auto: z.infer<typeof autoSchema>; manual: z.infer<typeof manualSchema>; shorts: z.infer<typeof shortSchema> };

/** Explicit allowlists exclude source IDs, attachments, words, timing and secret fields. */
export function captureFinishingPreset(mode: PresetMode, name: string, settings: unknown, id: string): FinishingPreset {
  const input = settings && typeof settings === "object" ? settings : {};
  return schema.parse({ id, name, mode, settings: mode === "auto"
    ? { ...input, visualSources: getVisualSources(input as AutoOptions) }
    : { ...DEFAULT_SETTINGS, ...input } });
}
export function restoreFinishingPresets(value: unknown): FinishingPreset[] {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("presets" in value) || !Array.isArray(value.presets)) return [];
  const seen = new Set<string>();
  return value.presets.slice(0, 60).flatMap(item => {
    const parsed = schema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) return [];
    seen.add(parsed.data.id); return [parsed.data];
  });
}
export function migrateManualPresets(value: unknown): FinishingPreset[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap(item => {
    try { return [captureFinishingPreset("manual", item.name, item.settings, item.id)]; } catch { return []; }
  });
}
