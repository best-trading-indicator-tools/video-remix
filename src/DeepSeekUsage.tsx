import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { DEEPSEEK_PRICING_URL, formatUsageUsd, type DeepSeekBalance } from "../shared/deepseek-usage";
import type { RenderJob } from "../shared/types";
import { apiRequest } from "./api-client";
import "./deepseek-usage.css";

export function DeepSeekUsageSummary({ job }: { job: RenderJob }) {
  const u = job.deepseekUsage;
  if (!u) return <p className="deepseek-unrecorded">DeepSeek usage not recorded{job.status === "processing" || job.status === "queued" ? " yet" : " for this export"}.</p>;
  const unknown = u.requests - u.reportedRequests;
  const priced = u.reportedRequests - u.unpricedRequests;
  const minimum = formatUsageUsd(u.estimatedUsd.min), maximum = formatUsageUsd(u.estimatedUsd.max);
  const range = minimum === maximum ? maximum : `${minimum}–${maximum}`;
  return <details className="deepseek-usage">
    <summary>DeepSeek · {u.reportedRequests ? `${u.totalTokens.toLocaleString()} tokens` : "tokens unavailable"} · {priced ? `est. ${range} USD` : "cost unavailable"}{unknown || u.unpricedRequests ? " · incomplete" : ""}</summary>
    <dl>
      <div><dt>Recorded input tokens</dt><dd>{u.inputTokens.toLocaleString()}</dd></div>
      <div><dt>Cached input tokens</dt><dd>{u.cachedInputTokens.toLocaleString()}{u.cacheDetailsMissing ? " (partial)" : ""}</dd></div>
      <div><dt>Recorded output tokens</dt><dd>{u.outputTokens.toLocaleString()}</dd></div>
      <div><dt>Responses with usage</dt><dd>{u.reportedRequests} / {u.requests} requests</dd></div>
    </dl>
    {unknown > 0 && <p>{unknown} request{unknown === 1 ? " has" : "s have"} no usage report yet (pending, failed or interrupted). Recorded cost may exclude charges for these requests.</p>}
    {u.unpricedRequests > 0 && <p>Pricing is unavailable for {u.unpricedRequests} recorded response{u.unpricedRequests === 1 ? "" : "s"}; their cost is excluded from this estimate.</p>}
    <p>{u.models.length ? `Models: ${u.models.join(", ")}. ` : ""}USD range uses <a href={DEEPSEEK_PRICING_URL} target="_blank" rel="noreferrer">published off-peak–peak rates</a>, verified {u.pricingDate}. {u.cacheDetailsMissing > 0 && "The range also allows for missing cache details. "}DeepSeek’s final bill may differ.</p>
    <p>Recorded since {new Date(u.firstUsedAt).toLocaleString()}. Includes this export’s processing, retries, rechecks and edit prompts. Prompts before export and other revisions are separate. Shared analysis is charged to the export that requested it.</p>
  </details>;
}

const money = (value: string, currency: string) => `${Number(value).toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency}`;
export function DeepSeekBalancePanel({ refreshKey }: { refreshKey: string }) {
  const [data, setData] = useState<DeepSeekBalance>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    apiRequest<DeepSeekBalance>("/api/deepseek/balance?refresh=1", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(() => { if (!controller.signal.aborted) { setData(undefined); setError("Could not load DeepSeek balance. Try refreshing."); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [refreshKey, refresh]);
  return <section className="deepseek-balance" aria-label="DeepSeek credit balance">
    <div className="deepseek-balance-heading"><strong>DeepSeek credit balance</strong>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} className={busy ? "spin" : undefined} />{busy ? "Checking…" : "Refresh balance"}</button>
    </div>
    {data?.balance ? <>
      <div className="deepseek-balances">{data.balance.balances.map(item => <div key={item.currency}>
        <strong>{money(item.total, item.currency)} remaining</strong>
        <span>{money(item.granted, item.currency)} granted · {money(item.toppedUp, item.currency)} topped up</span>
      </div>)}</div>
      {!data.balance.isAvailable && <p>DeepSeek reports that the balance is insufficient for API calls.</p>}
      <p>Account-wide balance · Checked {new Date(data.balance.checkedAt).toLocaleString()}. Includes activity outside this app.</p>
    </> : <p role="status">{error || data?.error || (data?.configured === false ? "Add your DeepSeek API key in Settings to see the remaining balance." : "Checking your account balance…")}</p>}
    <p>DeepSeek bills tokens against a money balance. There is no separate credit count. Each export below shows its recorded usage; historical usage cannot be reconstructed.</p>
  </section>;
}
