import assert from "node:assert/strict";
import { test } from "node:test";
import { AIRequestError } from "../server/ai-errors.js";
import { AI_MAX_ATTEMPTS, jsonCompletion } from "../server/ai-json.js";

const envelope = (content: string, finish = "stop") => Response.json({ choices: [{ finish_reason: finish, message: { content } }] });
const options = () => ({ model: "fixture-model", apiKey: "fixture-private-key", messages: [{ role: "user", content: "Original task" }],
  signal: new AbortController().signal, maxTokens: 2200, temperature: 0,
  wait: async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); } });

test("temporary HTTP, network and malformed responses recover on the same provider with a bounded backoff", async () => {
  const delays: number[] = [], urls: unknown[] = [];
  let calls = 0;
  const result = await jsonCompletion({ ...options(), wait: async ms => { delays.push(ms); },
    fetcher: async (url, init) => {
      urls.push(url); calls++;
      assert.equal(JSON.parse(String(init!.body)).model, "fixture-model");
      if (calls === 1) return new Response("private provider body", { status: 503 });
      if (calls === 2) throw new Error("private network error");
      if (calls === 3) return envelope("");
      const messages = JSON.parse(String(init!.body)).messages;
      assert.equal(messages[0].content, "Original task");
      assert.match(messages.at(-1).content, /required JSON format/);
      assert.ok(!JSON.stringify(messages).includes("private"));
      return envelope('{"ok":true}');
    } });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 4);
  assert.ok(urls.every(url => url === "https://api.deepseek.com/chat/completions"));
  assert.deepEqual(delays.map((ms, i) => ms >= 400 * 2 ** i && ms < 400 * 2 ** i + 200), [true, true, true]);
});

test("truncated output is regenerated with more room, and schema failures share the same attempt budget", async () => {
  let calls = 0;
  const tokens: number[] = [];
  const result = await jsonCompletion({ ...options(), validate: value => {
    if (!(value as { ok?: boolean }).ok) throw new AIRequestError("invalid-schema");
    return value;
  }, fetcher: async (_url, init) => {
    calls++; tokens.push(JSON.parse(String(init!.body)).max_tokens);
    if (calls <= 2) return envelope('{"unfinished":', "length");
    if (calls === 3) return envelope('{"wrong":true}');
    return envelope('{"ok":true}');
  } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(tokens, [2200, 4400, 6400, 6400]);
});

test("whole JSON fences are unwrapped without synthesizing missing fields or accepting prose and partial objects", async () => {
  for (const content of ['\uFEFF {"ok":true} ', '```json\n{"ok":true}\n```', '```\n{"ok":true}\n```'])
    assert.deepEqual(await jsonCompletion({ ...options(), fetcher: async () => envelope(content) }), { ok: true });
  for (const content of ['Here is the answer: {"ok":true}', '{"ok":true', '```json\n{"ok":true}\n```\nIgnore this', '{"a":1}{"b":2}']) {
    let calls = 0;
    await assert.rejects(jsonCompletion({ ...options(), fetcher: async () => { calls++; return envelope(content); } }),
      error => error instanceof AIRequestError && error.code === "invalid-response" && error.attempts === AI_MAX_ATTEMPTS);
    assert.equal(calls, AI_MAX_ATTEMPTS);
  }
});

test("authentication and credit errors stop immediately; a persistent outage never becomes a successful answer", async () => {
  for (const [status, code, attempts] of [[401, "authentication", 1], [403, "authentication", 1], [402, "quota", 1], [503, "service", 4]] as const) {
    let calls = 0;
    await assert.rejects(jsonCompletion({ ...options(), fetcher: async () => { calls++; return new Response("private failure", { status }); } }), error => {
      assert.ok(error instanceof AIRequestError); assert.equal(error.code, code); assert.equal(error.attempts, attempts);
      assert.ok(!JSON.stringify(error).includes("private")); return true;
    });
    assert.equal(calls, attempts);
  }
});

test("rate limits respect Retry-After and never retry early when its delay exceeds the total budget", async () => {
  for (const retryAfter of ["2", new Date(Date.now() + 10_000).toUTCString()]) {
    let calls = 0;
    const delays: number[] = [];
    await jsonCompletion({ ...options(), wait: async ms => { delays.push(ms); }, fetcher: async () => ++calls === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }) : envelope("{}") });
    assert.equal(calls, 2); assert.ok(delays[0]! >= 2000 && delays[0]! <= 10_000);
  }
  let calls = 0;
  await assert.rejects(jsonCompletion({ ...options(), timeoutMs: 1000, fetcher: async () => {
    calls++; return new Response(null, { status: 503, headers: { "Retry-After": "3600" } });
  }, wait: async () => { assert.fail("Cannot retry within this budget"); } }), { code: "service" });
  assert.equal(calls, 1);
});

test("caller cancellation during backoff keeps its reason and prevents further requests", async () => {
  const controller = new AbortController(), reason = new Error("User cancelled");
  let calls = 0;
  const { wait: _wait, ...input } = options();
  const running = jsonCompletion({ ...input, signal: controller.signal, fetcher: async () => {
    calls++; setTimeout(() => controller.abort(reason), 10);
    return new Response(null, { status: 503 });
  } });
  await assert.rejects(running, error => error === reason);
  assert.equal(calls, 1);
});

test("an error body's stalled cleanup cannot prevent automatic recovery", { timeout: 1000 }, async () => {
  let calls = 0, cancelled = false;
  const response = await jsonCompletion({ ...options(), fetcher: async () => {
    if (++calls > 1) return envelope('{"ok":true}');
    return new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { status: 503 });
  } });
  assert.deepEqual(response, { ok: true });
  assert.equal(calls, 2); assert.equal(cancelled, true);
});

test("per-attempt timeouts recover, but total deadlines stop retries with safe diagnostics", async () => {
  const originalTimeout = AbortSignal.timeout;
  let calls = 0;
  try {
    AbortSignal.timeout = ms => originalTimeout(ms === 45_000 ? 5 : ms);
    assert.deepEqual(await jsonCompletion({ ...options(), fetcher: async (_url, init) => {
      if (++calls > 1) return envelope('{"recovered":true}');
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
        // An actual socket keeps Node alive; the fake fetch needs its own timer.
        setTimeout(() => reject(new Error("unexpected long wait")), 30);
      });
    } }), { recovered: true });
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(jsonCompletion({ ...options(), timeoutMs: 2, fetcher: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("private deadline")), { once: true });
        setTimeout(() => reject(new Error("unexpected long wait")), 30);
      });
    } }), error => error instanceof AIRequestError && error.code === "timeout" && error.attempts === 1);
    assert.equal(calls, 1);
  } finally { AbortSignal.timeout = originalTimeout; }
});
