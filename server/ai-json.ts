import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { AIRequestError } from "./ai-errors.js";
const throwIfAborted = (signal: AbortSignal) => signal.throwIfAborted();

export const AI_MAX_ATTEMPTS = 4;
export const AI_REQUEST_BUDGET_MS = 120_000;
interface CompletionOptions {
  model: string;
  apiKey: string;
  messages: unknown[];
  signal: AbortSignal;
  maxTokens: number;
  temperature?: number;
  fetcher?: typeof fetch;
  /** Validation belongs inside the same retry budget as transport and JSON parsing. */
  validate?: (value: unknown) => unknown;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Test seam for backoff; production uses an abortable timer. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const retryInstruction = (code: AIRequestError["code"]) => code === "output-truncated"
  ? "The previous response was incomplete. Return the complete required JSON object. Keep descriptions concise; include every required field and check."
  : code === "invalid-evidence"
    ? "The previous response could not be verified against the supplied evidence. Copy exact quotations from the supplied source IDs and complete each requested comparison. Never invent evidence or assume a passing verdict. Return the complete JSON object."
    : "The previous response did not match the required JSON format. Return a complete JSON object following the original instructions and schema exactly. Include every required field, no additional fields, Markdown or commentary.";

/** One retry owner for transport, JSON, schema and evidence; caller cancellation always wins. */
export async function jsonCompletion(options: CompletionOptions): Promise<unknown> {
  const { signal, temperature, maxTokens, maxAttempts = AI_MAX_ATTEMPTS, timeoutMs = AI_REQUEST_BUDGET_MS,
    wait = async (ms, budget) => { await delay(ms, undefined, { signal: budget }); } } = options;
  signal.throwIfAborted();
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > AI_MAX_ATTEMPTS ||
    !Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 6400)
    throw new Error("Invalid provider request budget");
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2))
    throw new Error("Invalid provider temperature");
  const budgetMs = Math.min(AI_REQUEST_BUDGET_MS, Math.floor(timeoutMs));
  const deadline = Date.now() + budgetMs;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
  let tokens = maxTokens;
  let correction: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      budget.throwIfAborted();
      const raw = await completionAttempt({ ...options, signal: budget, maxTokens: tokens,
        messages: correction ? [...options.messages, { role: "user", content: correction }] : options.messages });
      const result = options.validate ? options.validate(raw) : raw;
      budget.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const failure = budget.aborted ? new AIRequestError("timeout") : error;
      if (!(failure instanceof AIRequestError)) throw failure;
      failure.attempts = attempt;
      if (budget.aborted || !failure.retryable || attempt === maxAttempts) throw failure;
      if (["output-truncated", "invalid-response", "invalid-schema", "invalid-evidence"].includes(failure.code))
        correction = retryInstruction(failure.code);
      if (failure.code === "output-truncated") tokens = Math.min(6400, tokens * 2);
      const backoff = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
      const waitMs = Math.max(backoff, failure.retryAfterMs ?? 0);
      // Do not hammer a provider whose Retry-After extends beyond this request's budget.
      if (waitMs >= deadline - Date.now()) throw failure;
      try { await wait(waitMs, budget); }
      catch {
        signal.throwIfAborted();
        const timeout = new AIRequestError("timeout"); timeout.attempts = attempt;
        throw timeout;
      }
    }
  }
  throw new AIRequestError("invalid-response");
}

/** Only the fixed provider endpoint receives media. Only fixed safe diagnostics escape. */
async function completionAttempt({
  model,
  apiKey,
  messages,
  signal,
  maxTokens,
  temperature,
  fetcher = fetch,
}: CompletionOptions): Promise<unknown> {
  throwIfAborted(signal);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2))
    throw new Error("Invalid provider temperature");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  let response: Response;
  try { response = await fetcher("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      max_tokens: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
    }),
    signal: requestSignal,
    redirect: "error",
  }); } catch {
    throwIfAborted(signal);
    throw new AIRequestError(requestSignal.aborted ? "timeout" : "network");
  }
  throwIfAborted(signal);
  if (requestSignal.aborted) throw new AIRequestError("timeout");
  if (!response.ok) {
    // Cancelling a teed/stalled body can wait on another consumer forever.
    // Cleanup must never prevent the bounded retry or caller cancellation.
    void response.body?.cancel().catch(() => undefined);
    throwIfAborted(signal);
    const failure = new AIRequestError(response.status === 401 || response.status === 403 ? "authentication" :
      response.status === 402 ? "quota" : response.status === 429 ? "rate-limit" :
        response.status >= 500 ? "service" : "invalid-response");
    if (response.status === 429 || response.status === 503) {
      const header = response.headers.get("retry-after")?.trim();
      if (header) {
        const ms = /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        if (Number.isFinite(ms)) failure.retryAfterMs = Math.max(0, ms);
      }
    }
    throw failure;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AIRequestError("invalid-response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      throwIfAborted(requestSignal);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64_000) throw new AIRequestError("invalid-response");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throwIfAborted(signal);
    if (requestSignal.aborted) throw new AIRequestError("timeout");
    throw error instanceof AIRequestError ? error : new AIRequestError("network");
  } finally {
    reader.releaseLock();
  }
  throwIfAborted(signal);
  if (requestSignal.aborted) throw new AIRequestError("timeout");
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AIRequestError("invalid-response"); }
  const parsed = z
    .object({
      choices: z
        .array(
          z.object({
            finish_reason: z.string(),
            message: z.unknown().optional(),
          }),
        )
        .min(1)
        .max(1),
    })
    .safeParse(raw);
  if (!parsed.success) throw new AIRequestError("invalid-response");
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === "length") throw new AIRequestError("output-truncated");
  if (choice.finish_reason !== "stop") throw new AIRequestError("invalid-response");
  const message = z.object({ content: z.string().min(1).max(20_000) }).safeParse(choice.message);
  if (!message.success) throw new AIRequestError("invalid-response");
  // Accept harmless whole-response Markdown wrapping, never manufacture missing JSON or evidence.
  const content = message.data.content.trim().replace(/^\uFEFF/u, "");
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(content);
  try { return JSON.parse(fenced ? fenced[1]! : content); }
  catch { throw new AIRequestError("invalid-response"); }
}
