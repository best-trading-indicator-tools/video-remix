/** Recorded provider responses only; monetary amounts are estimates, not invoices. */
export interface DeepSeekUsage {
  version: 1;
  firstUsedAt: string;
  lastUsedAt: string;
  requests: number;
  reportedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  unpricedRequests: number;
  cacheDetailsMissing: number;
  estimatedUsd: { min: number; max: number };
  models: string[];
  pricingDate: string;
}

export interface DeepSeekBalance {
  configured: boolean;
  balance?: {
    checkedAt: string;
    isAvailable: boolean;
    balances: { currency: "USD" | "CNY"; total: string; granted: string; toppedUp: string }[];
  };
  error?: string;
}

export const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
export const DEEPSEEK_PRICING_DATE = "2026-10-07";
// USD per million tokens, verified against the provider's published off-peak/peak
// table. Keep a range: public holidays, billing time and future rate changes can
// affect the invoice. Never infer a job's cost by subtracting account balances.
const FLASH = { hit: .003, miss: .15, output: .6 };
const PRO = { hit: .022, miss: .66, output: 1.98 };
const RATES: Record<string, typeof FLASH> = {
  "deepseek-flash": FLASH, "deepseek-v4-flash": FLASH, "deepseek-v4-flash-vision-exp": FLASH,
  "deepseek-v4.1-flash": FLASH, "deepseek-v4-pro": PRO, "deepseek-v4-pro-0813": PRO,
};
export function deepseekCost(model: string, input: number, output: number, cached?: number) {
  const rate = Object.hasOwn(RATES, model.toLowerCase()) ? RATES[model.toLowerCase()] : undefined;
  if (!rate) return undefined;
  const minimumCached = cached ?? 0, maximumCached = cached ?? input;
  return {
    min: (maximumCached * rate.hit + (input - maximumCached) * rate.miss + output * rate.output) / 1_000_000,
    max: 2 * (minimumCached * rate.hit + (input - minimumCached) * rate.miss + output * rate.output) / 1_000_000,
  };
}

export function formatUsageUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < .0001) return "<$0.0001";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}
