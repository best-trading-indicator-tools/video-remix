import type { SupportingVisualOptions, VisualSource } from "./types.js";

type VisualOptions = Pick<SupportingVisualOptions, "visualSources" | "supportingVisuals">;
export const VISUAL_SOURCES: readonly VisualSource[] = ["pixabay", "pexels", "hyperframes", "remotion", "library"];
export const VISUAL_SOURCE_LABELS: Record<VisualSource, string> = {
  pixabay: "Pixabay", pexels: "Pexels", hyperframes: "HyperFrames", remotion: "Remotion", library: "My B-roll",
};

/** Keep old jobs and saved presets readable; explicit selections always win. */
export function getVisualSources(options: VisualOptions = {}): VisualSource[] {
  if (Array.isArray(options.visualSources))
    return VISUAL_SOURCES.filter(source => options.visualSources!.includes(source));
  switch (options.supportingVisuals) {
    case "stock": return ["pixabay"];
    case "graphics": return ["hyperframes"];
    case "library": return ["library"];
    case "both": return ["hyperframes", "library"];
    default: return [];
  }
}
export const hasStockVisuals = (options: VisualOptions = {}) => getVisualSources(options).some(source => source === "pixabay" || source === "pexels");
export const hasLibraryVisuals = (options: VisualOptions = {}) => getVisualSources(options).includes("library");
export const hasGraphicVisuals = (options: VisualOptions = {}) => getVisualSources(options).some(source => source === "hyperframes" || source === "remotion");

/** Provider tags are retrieval hints, never sufficient evidence for an automatic cutaway. */
export const getBrollMatching = (options: VisualOptions & Pick<SupportingVisualOptions, "brollMatching"> = {}): "ai" | "tags" =>
  hasStockVisuals(options) || options.brollMatching === "ai" ? "ai" : "tags";
