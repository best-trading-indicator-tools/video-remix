import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { DEEPSEEK_PRICING_DATE, deepseekCost, type DeepSeekUsage } from "../shared/deepseek-usage.js";

type UsageOwner = { deepseekUsage?: DeepSeekUsage };
const context = new AsyncLocalStorage<{ owner: UsageOwner; save: () => Promise<void> }>();
/** Async scope keeps simultaneous exports/reviews separate without provider globals. */
export function withDeepSeekUsage<T>(owner: UsageOwner, work: () => Promise<T>, save: () => Promise<void> = async () => {}): Promise<T> {
  return context.run({ owner, save }, work);
}
const count = z.number().int().min(0).max(1_000_000_000);
const usageSchema = z.object({
  prompt_tokens: count, completion_tokens: count, total_tokens: count.optional(),
  prompt_cache_hit_tokens: count.optional(), prompt_cache_miss_tokens: count.optional(),
  prompt_tokens_details: z.object({ cached_tokens: count.optional() }).optional(),
});
const modelSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,96}$/u);

/** Record attempts before sending, including retries whose response may be lost. */
export async function beginDeepSeekRequest(model: string): Promise<(raw: unknown) => Promise<void>> {
  const scope = context.getStore();
  if (!scope) return async () => {};
  const now = new Date().toISOString();
  const usage = scope.owner.deepseekUsage ??= {
    version: 1, firstUsedAt: now, lastUsedAt: now, requests: 0, reportedRequests: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0,
    unpricedRequests: 0, cacheDetailsMissing: 0, estimatedUsd: { min: 0, max: 0 }, models: [], pricingDate: DEEPSEEK_PRICING_DATE,
  };
  const persist = async () => {
    // Cost recording must never fail an otherwise usable export. Its next normal
    // save retries persistence; no prompt, credential or provider body is logged.
    try { await scope.save(); } catch { console.error("Could not save DeepSeek usage counters."); }
  };
  usage.requests++;
  usage.lastUsedAt = now;
  await persist();
  let recorded = false;
  return async raw => {
    if (recorded) return;
    recorded = true;
    const envelope = z.object({ model: z.unknown().optional(), usage: z.unknown() }).safeParse(raw);
    if (!envelope.success) return;
    const parsed = usageSchema.safeParse(envelope.data.usage);
    if (!parsed.success) return;
    const u = parsed.data, total = u.prompt_tokens + u.completion_tokens;
    if (u.total_tokens !== undefined && u.total_tokens !== total) return;
    const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ??
      (u.prompt_cache_miss_tokens === undefined ? (u.prompt_tokens === 0 ? 0 : undefined) : u.prompt_tokens - u.prompt_cache_miss_tokens);
    if (cached !== undefined && (cached < 0 || cached > u.prompt_tokens ||
      (u.prompt_cache_miss_tokens !== undefined && cached + u.prompt_cache_miss_tokens !== u.prompt_tokens))) return;
    const actualModel = modelSchema.safeParse(envelope.data.model ?? model).data ?? "unknown";
    usage.reportedRequests++;
    usage.inputTokens += u.prompt_tokens; usage.outputTokens += u.completion_tokens; usage.totalTokens += total;
    usage.cachedInputTokens += cached ?? 0;
    if (cached === undefined) usage.cacheDetailsMissing++;
    const cost = deepseekCost(actualModel, u.prompt_tokens, u.completion_tokens, cached);
    if (cost) { usage.estimatedUsd.min += cost.min; usage.estimatedUsd.max += cost.max; }
    else usage.unpricedRequests++;
    if (!usage.models.includes(actualModel) && usage.models.length < 16) usage.models.push(actualModel);
    usage.lastUsedAt = new Date().toISOString();
    await persist();
  };
}
