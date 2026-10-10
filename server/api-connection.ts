import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApiConnectionResult, ApiProvider } from "../shared/api-keys.js";
import { postizConfiguration } from "./postiz.js";

const stock = z.object({ total: z.number().nonnegative(), hits: z.array(z.unknown()) });
const pexels = z.object({ total_results: z.number().nonnegative(), videos: z.array(z.unknown()) });
const balance = z.object({ is_available: z.boolean(), balance_infos: z.array(z.object({ currency: z.string(), total_balance: z.string() })).min(1) });

/** Read-only authentication checks: no generation, media upload, or publication. */
export class ApiConnectionService {
  private cache = new Map<string, { until: number; result: ApiConnectionResult }>();
  private pending = new Map<ApiProvider, Promise<ApiConnectionResult>>();
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args), private timeoutMs = 10_000,
    private postizEndpoint = () => postizConfiguration().endpoint) {}

  async check(provider: ApiProvider, apiKey: string): Promise<ApiConnectionResult> {
    const result = (status: ApiConnectionResult["status"], message: string): ApiConnectionResult => ({ status, message, checkedAt: new Date().toISOString() });
    if (!apiKey) return result("missing", "Paste an API key first, or save one in Settings.");
    const key = createHash("sha256").update(`${provider}\0${apiKey}`).digest("hex");
    for (const [id, item] of this.cache) if (item.until <= Date.now()) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (cached) return cached.result;
    if (this.pending.has(provider)) return result("rate-limited", "A connection check is already running. Try again in a moment.");
    const promise = this.read(provider, apiKey, result).then(value => {
      // Pixabay requires a 24-hour cache. A changed key is always checked anew.
      if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { result: value, until: Date.now() + (value.status === "ready" ? provider === "pixabay" ? 86_400_000 : 30_000 : 2_000) });
      return value;
    }).finally(() => this.pending.delete(provider));
    this.pending.set(provider, promise);
    return promise;
  }

  private async read(provider: ApiProvider, apiKey: string, result: (status: ApiConnectionResult["status"], message: string) => ApiConnectionResult) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async () => {
      let url: URL;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (provider === "deepseek") {
        url = new URL("https://api.deepseek.com/user/balance"); headers.Authorization = `Bearer ${apiKey}`;
      } else if (provider === "pixabay") {
        url = new URL("https://pixabay.com/api/videos/");
        url.search = new URLSearchParams({ key: apiKey, q: "nature", per_page: "3", safesearch: "true" }).toString();
      } else if (provider === "pexels") {
        url = new URL("https://api.pexels.com/v1/videos/search?query=nature&per_page=1"); headers.Authorization = apiKey;
      } else {
        url = new URL(`${this.postizEndpoint()}/integrations`); headers.Authorization = apiKey;
      }
      const response = await this.fetcher(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status) || (provider === "pixabay" && response.status === 400))
          return result("invalid", "The provider rejected this key. Copy it again and check your account permissions.");
        if (response.status === 402) return result("no-credit", "Add funds or check your provider account plan, then test again.");
        if (response.status === 429) return result("rate-limited", "Provider limit reached. Wait a little, then test again.");
        return result("unavailable", "The provider is temporarily unavailable. Try again shortly.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response");
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256_000) throw new Error("Response too large");
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (provider === "deepseek") {
        const account = balance.parse(payload);
        return account.is_available ? result("ready", "Ready for AI editing. Key accepted and account balance available.")
          : result("no-credit", "Key accepted. Add funds to your DeepSeek account to enable AI editing.");
      }
      if (provider === "pixabay") stock.parse(payload);
      else if (provider === "pexels") pexels.parse(payload);
      else z.array(z.object({ id: z.string() })).parse(payload);
      return result("ready", provider === "postiz" ? "Connected to Postiz. No post was created." : "Ready to search stock footage. Automatic matching also needs DeepSeek.");
    };
    try {
      return await Promise.race([request(), new Promise<ApiConnectionResult>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(result("unavailable", "Connection timed out. Check your internet connection and try again.")); }, this.timeoutMs);
      })]);
    } catch {
      // Provider errors and fetch URLs may contain credentials. Never expose them.
      return result("unavailable", "Could not verify the connection. Check your internet connection and try again.");
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
