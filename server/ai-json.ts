import { z } from "zod";
import { AIRequestError } from "./ai-errors.js";
const throwIfAborted = (signal: AbortSignal) => signal.throwIfAborted();

/** Only the fixed provider endpoint receives media. Only fixed safe diagnostics escape. */
export async function jsonCompletion({
  model,
  apiKey,
  messages,
  signal,
  maxTokens,
  temperature,
  fetcher = fetch,
}: {
  model: string;
  apiKey: string;
  messages: unknown[];
  signal: AbortSignal;
  maxTokens: number;
  temperature?: number;
  fetcher?: typeof fetch;
}): Promise<unknown> {
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
    await response.body?.cancel().catch(() => undefined);
    throwIfAborted(signal);
    throw new AIRequestError(response.status === 401 || response.status === 403 ? "authentication" :
      response.status === 402 ? "quota" : response.status === 429 ? "rate-limit" :
        response.status >= 500 ? "service" : "invalid-response");
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
    await reader.cancel().catch(() => undefined);
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
  try { return JSON.parse(message.data.content); }
  catch { throw new AIRequestError("invalid-response"); }
}
