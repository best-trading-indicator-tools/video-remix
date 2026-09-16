import type { Express } from "express";
import { z } from "zod";
import { analyzeSpeakerFocus } from "./speaker-focus.js";
import { assertLinkedSourceUnchanged, ImportError } from "./media-imports.js";
import { state } from "./store.js";

const time = z.number().finite().min(0).max(86400);
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
const requestSchema = z.object({
  sourceId: z.string().uuid(),
  cuts: z.array(z.object({ start: time, end: time, focalPoint: point.optional() }).strict().refine(cut => cut.end - cut.start >= 0.04)).min(1).max(60),
  seed: point.optional(),
}).strict();

/** Source IDs only; one bounded local analysis per workspace, cancelled on disconnect. */
export function installSpeakerFocusRoutes(app: Express, analyze = analyzeSpeakerFocus) {
  let busy = false;
  app.post("/api/speaker-focus", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose valid source intervals and a starting crop position." });
    const source = state.sources.find(item => item.id === parsed.data.sourceId);
    if (!source) return res.status(404).json({ error: "The source video is no longer available. Reimport it to use automatic centering." });
    if (parsed.data.cuts.some(cut => cut.end > source.duration + 0.001))
      return res.status(400).json({ error: "The selected sequences must stay within the source video." });
    if (busy) return res.status(409).json({ error: "Another short is being analyzed. Try automatic centering again in a moment." });
    busy = true;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 150_000);
    timeout.unref();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    try {
      await assertLinkedSourceUnchanged(source);
      controller.signal.throwIfAborted();
      const result = await analyze({ source, cuts: parsed.data.cuts, seed: parsed.data.seed, signal: controller.signal });
      controller.signal.throwIfAborted();
      return res.json(result);
    } catch (error) {
      if (res.destroyed) return;
      if (timedOut) return res.status(504).json({ error: "Automatic centering took too long. Retry with fewer sequences, or keep your manual framing." });
      if (error instanceof ImportError) return res.status(error.status).json({ error: error.message });
      return res.status(422).json({ error: "Automatic centering could not analyze this source. Keep your manual framing or try again." });
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", disconnected);
      busy = false;
    }
  });
}
