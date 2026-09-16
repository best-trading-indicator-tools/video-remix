import type { Express } from "express";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { paths } from "./config.js";
import { state } from "./store.js";
import { sourceTranscript } from "./auto.js";
import { assertLinkedSourceUnchanged, ImportError } from "./media-imports.js";
import { pacingOptionsSchema, suggestPacing } from "../shared/pacing.js";
const schema = z
  .object({
    sourceId: z.string().uuid(),
    options: pacingOptionsSchema,
    cuts: z
      .array(
        z
          .object({
            start: z.number().finite().nonnegative(),
            end: z.number().finite().positive(),
          })
          .strict()
          .refine((cut) => cut.end - cut.start >= 0.05),
      )
      .min(1)
      .max(60),
  })
  .strict();
export function installPacingRoutes(
  app: Express,
  transcribe = sourceTranscript,
) {
  let busy = false;
  app.post("/api/shorts/pacing", async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Choose valid pacing settings and source sequences." });
    const source = state.sources.find(
      (item) => item.id === parsed.data.sourceId,
    );
    if (!source)
      return res
        .status(404)
        .json({ error: "Reimport this source before analyzing its pacing." });
    if (parsed.data.cuts.some((cut) => cut.end > source.duration + 0.001))
      return res
        .status(400)
        .json({ error: "Keep the sequences within this video." });
    if (!source.hasAudio)
      return res
        .status(422)
        .json({ error: "Pacing analysis needs spoken audio." });
    if (busy)
      return res
        .status(409)
        .json({
          error:
            "Another pacing analysis is running. Try again after it finishes.",
        });
    busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60_000);
    timeout.unref();
    const close = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", close);
    let directory: string | undefined;
    try {
      await assertLinkedSourceUnchanged(source);
      await mkdir(paths.work, { recursive: true });
      directory = await mkdtemp(path.join(paths.work, "pacing-"));
      const transcript = await transcribe(
        source,
        directory,
        controller.signal,
        () => {},
      );
      controller.signal.throwIfAborted();
      res.json(
        suggestPacing(transcript, parsed.data.cuts, parsed.data.options),
      );
    } catch (error) {
      if (!res.destroyed)
        res
          .status(error instanceof ImportError ? error.status : 422)
          .json({
            error:
              error instanceof ImportError
                ? error.message
                : "Pacing analysis could not finish. Check the local speech model, or keep the current timing.",
          });
    } finally {
      clearTimeout(timeout);
      res.removeListener("close", close);
      busy = false;
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
