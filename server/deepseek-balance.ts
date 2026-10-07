import { createHash } from "node:crypto";
import { z } from "zod";
import type { Express } from "express";
import type { DeepSeekBalance } from "../shared/deepseek-usage.js";
import { providerApiKey } from "./api-keys.js";

const money = z.string().regex(/^-?\d{1,15}(?:\.\d{1,12})?$/u);
const schema = z.object({ is_available: z.boolean(), balance_infos: z.array(z.object({
  currency: z.enum(["USD", "CNY"]), total_balance: money, granted_balance: money, topped_up_balance: money,
})).min(1).max(2) }).refine(value => new Set(value.balance_infos.map(item => item.currency)).size === value.balance_infos.length);

/** Cache by credential identity, with single-flight requests and no secret in responses. */
export class DeepSeekBalanceService {
  private cache?: { key: string; at: number; result: DeepSeekBalance };
  private pending?: { key: string; promise: Promise<DeepSeekBalance> };
  constructor(private readonly key = () => providerApiKey("deepseek"),
    private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly timeoutMs = 8_000) {}

  async get(refresh = false): Promise<DeepSeekBalance> {
    const apiKey = this.key();
    if (!apiKey) { this.cache = undefined; return { configured: false }; }
    const key = createHash("sha256").update(apiKey).digest("hex");
    if (this.pending?.key === key) return this.pending.promise;
    if (this.cache?.key === key && Date.now() - this.cache.at < (refresh ? 2_000 : 15_000)) return this.cache.result;
    const promise = this.read(apiKey).then(result => {
      // A key changed while reading must not replace that account's newer cache.
      if (createHash("sha256").update(this.key()).digest("hex") === key) this.cache = { key, at: Date.now(), result };
      return result;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
    this.pending = { key, promise };
    return promise;
  }

  private async read(apiKey: string): Promise<DeepSeekBalance> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = (error: string): DeepSeekBalance => ({ configured: true, error });
    const request = async (): Promise<DeepSeekBalance> => {
      const response = await this.fetcher("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: controller.signal, redirect: "error",
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return unavailable(response.status === 401 || response.status === 403
          ? "DeepSeek could not authenticate the key. Check Settings."
          : "DeepSeek balance is temporarily unavailable. Try refreshing.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing balance response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8_192) throw new Error("Oversized balance response");
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const parsed = schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return { configured: true, balance: { checkedAt: new Date().toISOString(), isAvailable: parsed.is_available,
        balances: parsed.balance_infos.map(item => ({ currency: item.currency, total: item.total_balance, granted: item.granted_balance, toppedUp: item.topped_up_balance })) } };
    };
    try {
      return await Promise.race([request(), new Promise<DeepSeekBalance>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(unavailable("DeepSeek balance timed out. Try refreshing.")); }, this.timeoutMs);
        timer.unref();
      })]);
    } catch { return unavailable("DeepSeek balance is temporarily unavailable. Try refreshing."); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}

export function installDeepSeekBalanceRoutes(app: Express, service = new DeepSeekBalanceService()) {
  app.get("/api/deepseek/balance", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await service.get(req.query.refresh === "1"));
  });
}
