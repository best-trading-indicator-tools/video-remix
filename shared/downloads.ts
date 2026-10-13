import { z } from "zod";
import { socialCarouselLink, socialVideoLink } from "./social-imports.js";

export const downloadDraftSchema = z.object({
  kind: z.enum(["video", "carousel"]),
  links: z.array(z.string().trim().min(1).max(2048)).max(100),
  stripMetadata: z.boolean(),
}).strict().superRefine((value, ctx) => {
  for (const [index, link] of value.links.entries()) {
    try { (value.kind === "carousel" ? socialCarouselLink : socialVideoLink)(link); }
    catch { ctx.addIssue({ code: "custom", path: ["links", index], message: "Use a direct supported post URL for this download type." }); }
  }
});
export type DownloadDraft = z.infer<typeof downloadDraftSchema>;
export interface DownloadProposal { draft: DownloadDraft; summary: string[]; clarification?: string }

export function normalizeDownloadDraft(value: DownloadDraft): DownloadDraft {
  const draft = downloadDraftSchema.parse(value);
  return { ...draft, links: [...new Set(draft.links.map(link => (draft.kind === "carousel" ? socialCarouselLink : socialVideoLink)(link).url))],
    stripMetadata: draft.kind === "carousel" ? false : draft.stripMetadata };
}
