import type { Express } from "express";
import { z } from "zod";
import type { EditPlan, EditPlanChanges, PromptEditResponse, Transcript } from "../shared/types.js";
import { applyEditPlanChanges, editPlanChangesSchema } from "./edit-plan.js";
import { publicEditPlan } from "./plan-storage.js";
import { isActive, isRunning } from "./queue.js";
import { state } from "./store.js";
import { brollAIConfigured } from "./broll-ai.js";
import { stockBrollConfigured, stockProvidersForEdit } from "./stock-broll.js";
import { proposePromptEdit, PromptEditError } from "./prompt-edit.js";
import { proposeManualPrompt } from "./manual-prompt.js";
import { settingsSchema } from "./schema.js";
import { manualPreviewSettings } from "./manual-preview.js";

const requestSchema = z.object({
  revision: z.number().int().nonnegative(),
  prompt: z.string().trim().min(1).max(2000),
  draft: editPlanChangesSchema.optional(),
}).strict();
const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
const manualRequestSchema = z.object({ prompt: z.string().trim().min(1).max(2000), settings: settingsSchema }).strict();

/** Keep automatic retiming implicit so a cut change can also request fresh stock. */
export function changesBetweenPlans(base: EditPlan, next: EditPlan, transcript?: Transcript, refreshBroll?: boolean): EditPlanChanges {
  const changes: EditPlanChanges = { revision: base.revision };
  if (differs(base.cuts, next.cuts)) changes.cuts = next.cuts;
  const retimed = changes.cuts ? applyEditPlanChanges(base, changes, transcript) : base;
  if (base.settings.hookText !== next.settings.hookText) changes.hookText = next.settings.hookText;
  if (differs(retimed.captions, next.captions)) changes.captions = next.captions;
  if (differs(retimed.visuals, next.visuals)) changes.visuals = next.visuals;
  const framing: NonNullable<EditPlanChanges["framing"]> = {};
  for (const key of ["fit", "focalPoint", "captionStyle"] as const) {
    if (differs(base.settings[key], next.settings[key])) Object.assign(framing, { [key]: next.settings[key] });
  }
  if (Object.keys(framing).length) changes.framing = framing;
  if (refreshBroll) changes.refreshBroll = true;
  // Validate exactly the patch that the ordinary revision endpoint will receive.
  applyEditPlanChanges(base, changes, transcript);
  return changes;
}

/** Suggestions are read-only. The existing revision route remains the sole renderer. */
export function installPromptEditRoutes(app: Express) {
  const pending = new Map<string, AbortController>();
  app.post("/api/sources/:id/edit-prompt", async (req, res) => {
    const parsed = manualRequestSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Describe your edit in 1–2,000 characters and check the current video settings." });
    const source = state.sources.find(item => item.id === req.params.id);
    if (!source) return void res.status(404).json({ error: "This source is no longer available. Import it again to make edits." });
    const key = `source:${source.id}`;
    if (pending.has(key) || pending.size >= 2)
      return void res.status(429).json({ error: "Another edit suggestion is still running. Cancel it or wait for it to finish." });
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnect); pending.set(key, controller);
    try {
      try { manualPreviewSettings(parsed.data.settings, source); }
      catch (error) { throw new PromptEditError(400, error instanceof Error ? error.message : "Check the current trim and source settings."); }
      const proposal = await proposeManualPrompt({ settings: parsed.data.settings, source,
        prompt: parsed.data.prompt, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (!state.sources.includes(source)) return void res.status(409).json({ error: "This source was removed while preparing the suggestion. Select a source again." });
      res.json(proposal);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      res.status(error instanceof PromptEditError ? error.status : 502).json({
        error: error instanceof PromptEditError ? error.message : "The edit suggestion could not be prepared. Try a simpler request.",
      });
    } finally {
      res.off("close", disconnect);
      if (pending.get(key) === controller) pending.delete(key);
    }
  });
  app.post("/api/jobs/:id/edit-prompt", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Describe your edit in 1–2,000 characters and use a valid saved draft." });
    const parent = state.jobs.find(job => job.id === req.params.id);
    if (!parent?.editPlan) return void res.status(404).json({ error: "This export has no saved editable plan. Create an Auto edit first." });
    if (isActive(parent) || isRunning(parent.id)) return void res.status(409).json({ error: "Wait for this export to finish before editing it." });
    if (!state.sources.some(source => source.id === parent.sourceId)) return void res.status(404).json({ error: "The source has expired. Import it again to make edits." });
    const { revision, prompt, draft } = parsed.data;
    if (revision !== parent.editPlan.revision || (draft && draft.revision !== revision))
      return void res.status(409).json({ error: "This edit has changed. Reload its saved plan." });
    if (pending.has(parent.id) || pending.size >= 2)
      return void res.status(429).json({ error: "Another edit suggestion is still running. Cancel it or wait for it to finish." });
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", disconnect);
    pending.set(parent.id, controller);
    try {
      const baseline = parent.editPlan;
      let effective: EditPlan;
      try {
        effective = draft ? applyEditPlanChanges(baseline, draft, parent.sourceTranscript) : structuredClone(baseline);
        effective.revision = revision;
      } catch (error) {
        throw new PromptEditError(400, error instanceof Error ? error.message : "Check your current draft before describing another edit.");
      }
      const canRefreshBroll = stockBrollConfigured(stockProvidersForEdit(parent.auto)) &&
        (parent.auto?.brollMatching !== "ai" || brollAIConfigured());
      const proposal = await proposePromptEdit({ plan: effective, prompt, signal: controller.signal,
        sourceTranscript: parent.sourceTranscript, canRefreshBroll, pendingBrollCount: draft?.refreshBroll ? draft.brollCount : undefined });
      controller.signal.throwIfAborted();
      if (!state.jobs.includes(parent) || parent.editPlan !== baseline || !state.sources.some(source => source.id === parent.sourceId))
        return void res.status(409).json({ error: "This edit is no longer available. Reload your exports." });
      let next = effective;
      let changes: EditPlanChanges = { revision };
      if (!proposal.clarification) {
        next = applyEditPlanChanges(effective, proposal.changes, parent.sourceTranscript);
        try {
          // An explicit shot correction replaces an earlier request to search
          // again; otherwise the requested saved choice would be overwritten.
          const refreshBroll = proposal.changes.refreshBroll ?? (proposal.changes.visuals ? false : draft?.refreshBroll);
          changes = changesBetweenPlans(baseline, next, parent.sourceTranscript, refreshBroll);
          if (refreshBroll) {
            const search = proposal.changes.refreshBroll ? proposal.changes : draft;
            if (search?.brollCount !== undefined) changes.brollCount = search.brollCount;
            const coverage = search?.brollMaxCoverage ?? draft?.brollMaxCoverage;
            if (coverage !== undefined) changes.brollMaxCoverage = coverage;
            if (search?.preserveBroll !== undefined) changes.preserveBroll = search.preserveBroll;
          }
        } catch (error) {
          throw new PromptEditError(400, error instanceof Error ? error.message : "These changes cannot be combined with the current draft.");
        }
      }
      next.revision = revision;
      const response: PromptEditResponse = { revision, changes,
        plan: publicEditPlan({ ...parent, editPlan: next }), summary: proposal.summary,
        ...(proposal.clarification ? { clarification: proposal.clarification } : {}) };
      res.json(response);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      res.status(error instanceof PromptEditError ? error.status : 502).json({
        error: error instanceof PromptEditError ? error.message : "The edit suggestion could not be prepared. Try a simpler request.",
      });
    } finally {
      res.off("close", disconnect);
      if (pending.get(parent.id) === controller) pending.delete(parent.id);
    }
  });
}
