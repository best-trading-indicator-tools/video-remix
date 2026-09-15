import { z } from "zod";
const throwIfAborted = (signal: AbortSignal) => signal.throwIfAborted();

/** Only the fixed provider endpoint receives media. Diagnostics never escape. */
export async function jsonCompletion({
  model,
  apiKey,
  messages,
  signal,
  maxTokens,
  fetcher = fetch,
}: {
  model: string;
  apiKey: string;
  messages: unknown[];
  signal: AbortSignal;
  maxTokens: number;
  fetcher?: typeof fetch;
}): Promise<unknown> {
  throwIfAborted(signal);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  const response = await fetcher("https://api.deepseek.com/chat/completions", {
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
    }),
    signal: requestSignal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Provider request failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider response was empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      throwIfAborted(requestSignal);
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64_000) throw new Error("Provider response exceeded limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const envelope = z
    .object({
      choices: z
        .array(
          z.object({
            finish_reason: z.literal("stop"),
            message: z.object({ content: z.string().min(1).max(20_000) }),
          }),
        )
        .min(1)
        .max(1),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  return JSON.parse(envelope.choices[0]!.message.content);
}
