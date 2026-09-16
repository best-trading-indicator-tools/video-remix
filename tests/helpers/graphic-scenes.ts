import { groundGraphicScenes, type planGraphicScenes } from "../../server/graphic-planner.js";

/** Deterministic planner seam for dispatch/render tests; no paid AI requests. */
export const fixtureGraphics: typeof planGraphicScenes = async ({ moments, signal }) => {
  signal.throwIfAborted();
  const raw = { scenes: moments.slice(0, 12).map((moment, momentIndex) => ({ momentIndex, scene: {
    kind: "illustration", title: moment.text.split(/\s+/u).slice(0, 5).join(" ").slice(0, 48), unit: "",
    reason: "A concrete illustration of this spoken phrase.",
    nodes: [{ label: moment.text.split(/\s+/u).slice(0, 2).join(" ").slice(0,28), icon: "sun", quote: moment.text, value: null, at: 0 }],
  } })) };
  return { scenes: groundGraphicScenes(raw, moments), notes: [] };
};
