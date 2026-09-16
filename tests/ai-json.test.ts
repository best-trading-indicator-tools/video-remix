import assert from "node:assert/strict";
import { test } from "node:test";
import { AIRequestError, type AIRequestErrorCode } from "../server/ai-errors.js";
import { jsonCompletion, semanticReasoning } from "../server/ai-json.js";

const secret = "private-provider-response-and-key";
const request = (fetcher: typeof fetch, signal = new AbortController().signal) => jsonCompletion({
  model: "fixture-model", apiKey: secret, messages: [], maxTokens: 100, signal, fetcher, maxAttempts: 1,
});
const failure = (code: AIRequestErrorCode, retryable = true) => (error: unknown) => {
  assert.ok(error instanceof AIRequestError);
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
  assert.equal(error.message, new AIRequestError(code).message);
  assert.ok(!JSON.stringify(error).includes(secret));
  assert.ok(!String(error.stack).includes(secret));
  assert.equal(error.cause, undefined);
  return true;
};
const envelope = (content: string, finish_reason = "stop") => Response.json({ choices: [{ finish_reason, message: { content } }] });

test("thinking is explicit, budgeted, and never exposes reasoning as the result", async () => {
  const base = { model: "fixture", apiKey: secret, messages: [], maxTokens: 80, temperature: 0.2,
    signal: new AbortController().signal, maxAttempts: 1 };
  for (const reasoning of ["none", "low"] as const) {
    const result = await jsonCompletion({ ...base, reasoning, fetcher: async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.thinking.type, reasoning === "none" ? "disabled" : "enabled");
      assert.equal(body.reasoning_effort, reasoning === "none" ? undefined : "low");
      assert.equal(body.temperature, reasoning === "none" ? 0.2 : undefined);
      assert.equal(body.max_tokens, reasoning === "none" ? 80 : 8272);
      return Response.json({ choices: [{ finish_reason: "stop", message: {
        content: '{"chosen":1}', reasoning_content: secret.repeat(reasoning === "none" ? 1 : 2200),
      } }] });
    } });
    assert.deepEqual(result, { chosen: 1 });
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  for (const response of [
    () => envelope("x".repeat(20001)),
    () => new Response("x".repeat(256001)),
    () => Response.json({ choices: [{ finish_reason: "stop", message: { content: null, reasoning_content: '{"chosen":1}' } }] }),
  ]) await assert.rejects(jsonCompletion({ ...base, reasoning: "low", fetcher: async () => response() }), failure("invalid-response"));
  await jsonCompletion({ ...base, maxTokens: 6400, reasoning: "low", fetcher: async (_url, init) => {
    assert.equal(JSON.parse(String(init!.body)).max_tokens, 12800, "The initial combined budget also respects the hard ceiling");
    return envelope("{}");
  } });
});

test("thinking retries increase the combined budget without exceeding the attempt or token ceiling", async () => {
  const tokens: number[] = [];
  await assert.rejects(jsonCompletion({ model: "fixture", apiKey: secret, messages: [], maxTokens: 2200,
    reasoning: "low", signal: new AbortController().signal, wait: async () => {}, fetcher: async (_url, init) => {
      const body = JSON.parse(String(init!.body)); tokens.push(body.max_tokens);
      assert.ok(!JSON.stringify(body).includes(secret));
      return envelope("", "length");
    } }), error => { assert.ok(error instanceof AIRequestError); assert.equal(error.attempts, 4); return failure("output-truncated")(error); });
  assert.deepEqual(tokens, [10392, 12800, 12800, 12800]);
});

test("semantic decisions can be compared in fast mode without changing the model", () => {
  const previous = process.env.DEEPSEEK_THINKING;
  try {
    delete process.env.DEEPSEEK_THINKING; assert.equal(semanticReasoning(), "low");
    process.env.DEEPSEEK_THINKING = "false"; assert.equal(semanticReasoning(), "none");
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_THINKING; else process.env.DEEPSEEK_THINKING = previous;
  }
});

test("HTTP failures expose fixed categories and discard private response bodies without retrying", async () => {
  for (const [status, code, retryable] of [
    [401, "authentication", false], [403, "authentication", false], [402, "quota", false],
    [429, "rate-limit", true], [500, "service", true], [503, "service", true], [400, "invalid-response", true],
  ] as const) {
    let calls = 0;
    await assert.rejects(request(async () => { calls++; return new Response(secret, { status }); }), failure(code, retryable));
    assert.equal(calls, 1);
  }
});

test("truncated output is distinguished from invalid envelopes and malformed JSON", async () => {
  await assert.rejects(request(async () => envelope('{"unfinished":', "length")), failure("output-truncated"));
  await assert.rejects(request(async () => Response.json({ choices: [{ finish_reason: "length", message: { content: null } }] })), failure("output-truncated"));
  for (const response of [
    () => new Response(secret),
    () => Response.json({ choices: [] }),
    () => envelope(secret),
    () => envelope("{}", "content_filter"),
    () => envelope("x".repeat(20001)),
    () => new Response("x".repeat(64001)),
    () => new Response(null),
  ]) await assert.rejects(request(async () => response()), failure("invalid-response"));
  assert.deepEqual(await request(async () => envelope('{"chosen":2}')), { chosen: 2 });
});

test("connection and response-stream failures do not expose the underlying error", async () => {
  await assert.rejects(request(async () => { throw new Error(secret); }), failure("network"));
  await assert.rejects(request(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(secret)); },
  }))), failure("network"));
});

test("internal timeouts are retryable but caller cancellation retains its original reason", async () => {
  const originalTimeout = AbortSignal.timeout;
  const budget = new AbortController();
  try {
    AbortSignal.timeout = () => budget.signal;
    await assert.rejects(request(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error(secret)), { once: true });
      queueMicrotask(() => budget.abort(new DOMException("internal deadline", "TimeoutError")));
    })), failure("timeout"));
  } finally { AbortSignal.timeout = originalTimeout; }
  const controller = new AbortController(), reason = new Error("Caller cancelled this request");
  await assert.rejects(request(async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    queueMicrotask(() => controller.abort(reason));
  }), controller.signal), error => error === reason);
  await assert.rejects(request(async () => { assert.fail("Cancelled callers cannot send another request"); }, controller.signal), error => error === reason);
});
