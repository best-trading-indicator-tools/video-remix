import { geometry, probeMedia } from "./engine.js";
import type { StoredJob, StoredSource } from "./store.js";

/** Keep caption-only revisions of old Auto exports at their previous native size. */
export async function migrateLegacyPlanResolutions(sources: StoredSource[], jobs: StoredJob[]) {
  const byId = new Map(sources.map(source => [source.id, source]));
  for (const job of jobs) {
    const plan = job.editPlan;
    if (!job.auto || !plan || plan.resolutionSizing === "exact") continue;
    const source = byId.get(job.sourceId);
    // A missing source cannot render; leave the marker absent so a restored
    // source can still establish the original geometry on a later startup.
    if (!source) continue;
    if (plan.settings.resolution !== "source") {
      const native = geometry(source, { ...plan.settings, resolution: "source" });
      if (Math.min(native.width, native.height) < Number(plan.settings.resolution)) {
        let preserveNative = true;
        if (job.status === "completed") {
          try {
            // Retained pixels take precedence over the legacy cap assumption.
            // A development-era export may already have used exact Full HD.
            const actual = await probeMedia(job.outputPath, AbortSignal.timeout(3000));
            preserveNative = actual.width === native.width && actual.height === native.height;
          } catch {
            // Missing/expired outputs retain the old plan's no-upscaling rule.
          }
        }
        if (preserveNative) {
          plan.settings.resolution = "source";
          job.settings.resolution = "source";
        }
      }
    }
    // Persist once, and carry through structured-cloned revisions. Future
    // captures set this marker directly, including intentional exact upscales.
    plan.resolutionSizing = "exact";
  }
}
