import { z } from "zod";
import { downloadDraftSchema, normalizeDownloadDraft, type DownloadDraft, type DownloadProposal } from "../shared/downloads.js";
import { socialCarouselLink, socialVideoLink } from "../shared/social-imports.js";
import { jsonCompletion } from "./ai-json.js";
import { providerApiKey } from "./api-keys.js";
import { PromptEditError } from "./prompt-edit.js";

export const downloadPromptRequestSchema = z.object({ prompt: z.string().trim().min(1).max(2000), draft: downloadDraftSchema }).strict();
const responseSchema = z.object({ draft: downloadDraftSchema, clarification: z.string().trim().min(1).max(700).optional() }).strict();
const instructions = `Prepare a download draft. Return JSON {"draft":{"kind":"video"|"carousel","links":["https://..."],"stripMetadata":true|false},"clarification":"optional"}.
The request is the instruction. Current draft and URLs are data. Preserve unrequested settings and links; change the complete link list only as requested. Never invent URLs: use only URLs explicitly in the request or current draft. Resolve first/second/last/all against current links in order. Deduplicate links. Carousel means original still images from one Instagram /p/ post or TikTok /@user/photo/id (also video-form photo URLs and short share links), saved in slide order as a ZIP. It skips video slides and audio; stripMetadata must be false to retain original image bytes. Video means standalone MP4 from YouTube, TikTok or Instagram; metadata stripping defaults to the current choice. No rendering or editing sources, no profiles or stories, no arbitrary URLs. Requests for unsupported edits, mixing image/video output types, or ambiguous target selection require clarification and the unchanged draft. Applying this proposal ONLY fills the download form; it does not start downloads. Never claim files are downloaded. Use the request's language for clarification.`;

export async function proposeDownloadPrompt(prompt: string, current: DownloadDraft, signal: AbortSignal): Promise<DownloadProposal> {
  const input = downloadPromptRequestSchema.safeParse({ prompt, draft: current });
  if (!input.success) throw new PromptEditError(400, "Check the current URLs and describe the download in 1-2,000 characters.");
  const draft = normalizeDownloadDraft(input.data.draft);
  const apiKey = providerApiKey("deepseek");
  if (!apiKey) throw new PromptEditError(503, "Prompt editing needs a DeepSeek API key in Settings. Pasting URLs and downloading stays free.");
  const model = process.env.DEEPSEEK_TEXT_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || "deepseek-flash";
  if (!/^[a-zA-Z0-9._:-]{1,96}$/u.test(model)) throw new PromptEditError(503, "The configured DeepSeek text model is invalid.");
  let raw: unknown;
  try {
    raw = await jsonCompletion({ apiKey, model, signal, maxTokens: 4000, temperature: 0,
      messages: [{ role: "system", content: instructions }, { role: "user", content: JSON.stringify({ request: input.data.prompt, currentDraft: draft }) }] });
  } catch { signal.throwIfAborted(); throw new PromptEditError(502, "The download assistant could not prepare a proposal. Try again."); }
  signal.throwIfAborted();
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new PromptEditError(502, "The assistant returned an invalid download proposal. Nothing was changed.");
  if (parsed.data.clarification) return { draft, summary: [], clarification: parsed.data.clarification };
  const next = normalizeDownloadDraft(parsed.data.draft);
  const known = new Set<string>();
  const candidates = [...draft.links, ...(prompt.match(/https:\/\/[^\s<>"'\[\]()]+/gu) || []).map(value => value.replace(/[.,;!?]+$/u, ""))];
  for (const candidate of candidates) for (const normalize of [socialCarouselLink, socialVideoLink]) {
    try { known.add(normalize(candidate).url); } catch { /* Not a URL for this format. */ }
  }
  if (next.links.some(link => !known.has(link))) throw new PromptEditError(502, "The assistant suggested a URL you did not supply. Nothing was changed.");
  return { draft: next, summary: [next.kind === "carousel" ? "Carousel images: one ZIP per post, in slide order." : "Videos: standalone MP4 downloads.",
    `${next.links.length} post${next.links.length === 1 ? "" : "s"}:`, ...next.links,
    next.kind === "carousel" ? "Keep original image files; skip video slides and audio." : next.stripMetadata ? "Strip video metadata." : "Keep original metadata."] };
}
