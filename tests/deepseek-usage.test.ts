import assert from "node:assert/strict";
import { test } from "node:test";
import { withDeepSeekUsage } from "../server/deepseek-usage.js";
import { jsonCompletion } from "../server/ai-json.js";
import { deepseekCost, formatUsageUsd, type DeepSeekUsage } from "../shared/deepseek-usage.js";

const owner = (): { deepseekUsage?: DeepSeekUsage } => ({});
const options = { model: "deepseek-flash", apiKey: "secret-test-key", maxTokens: 100,
  signal: new AbortController().signal, messages: [{ role: "user", content: "Private caption" }], wait: async () => {} };
const envelope = (tokens: number, content = '{"ok":true}', finish = "stop", model = "deepseek-flash") => Response.json({
  model, usage: { prompt_tokens: tokens, prompt_cache_hit_tokens: tokens / 2, prompt_cache_miss_tokens: tokens / 2,
    completion_tokens: 10, total_tokens: tokens + 10 },
  choices: [{ finish_reason: finish, message: { content, reasoning_content: "Private reasoning" } }],
});

test("usage records billed retries before JSON validation, persists and accumulates later reviews", async () => {
  const job = owner(), saved: DeepSeekUsage[] = [];
  let calls = 0;
  await withDeepSeekUsage(job, () => jsonCompletion({ ...options, fetcher: async () => ++calls === 1
    ? envelope(100, '{"incomplete":', "length") : envelope(200) }), async () => { saved.push(structuredClone(job.deepseekUsage!)); });
  assert.equal(job.deepseekUsage?.requests, 2);
  assert.equal(job.deepseekUsage?.reportedRequests, 2);
  assert.equal(job.deepseekUsage?.totalTokens, 320);
  assert.equal(job.deepseekUsage?.cachedInputTokens, 150);
  assert.ok(Math.abs(job.deepseekUsage!.estimatedUsd.min - .00003495) < 1e-12);
  assert.equal(job.deepseekUsage!.estimatedUsd.max, job.deepseekUsage!.estimatedUsd.min * 2);
  assert.equal(saved[0]?.requests, 1);
  assert.equal(saved[0]?.reportedRequests, 0, "Pending/lost calls remain visible");
  assert.equal(saved.at(-1)?.totalTokens, 320);
  const restored = JSON.parse(JSON.stringify(job));
  await withDeepSeekUsage(restored, () => jsonCompletion({ ...options, fetcher: async () => envelope(20) }));
  assert.equal(restored.deepseekUsage.totalTokens, 350);
  assert.equal(restored.deepseekUsage.requests, 3);
  const serialized = JSON.stringify(restored);
  for (const value of [options.apiKey, "Private caption", "Private reasoning", "incomplete"]) assert.ok(!serialized.includes(value));
});

test("overlapping exports own their requests and calls outside an export do not leak in", async () => {
  const first = owner(), second = owner();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = withDeepSeekUsage(first, () => jsonCompletion({ ...options, fetcher: async () => { await gate; return envelope(400); } }));
  await withDeepSeekUsage(second, () => jsonCompletion({ ...options, fetcher: async () => envelope(100) }));
  await jsonCompletion({ ...options, fetcher: async () => envelope(900) });
  release(); await pending;
  assert.equal(first.deepseekUsage?.totalTokens, 410);
  assert.equal(second.deepseekUsage?.totalTokens, 110);
  const revision = owner();
  await withDeepSeekUsage(revision, async () => {});
  assert.equal(revision.deepseekUsage, undefined, "No inferred charges for a revision with no provider calls");
});

test("missing or invalid usage and unknown models never masquerade as a complete zero-dollar bill", async () => {
  const job = owner();
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: 10 }, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 1 }]) {
    await withDeepSeekUsage(job, () => jsonCompletion({ ...options, fetcher: async () => Response.json({ usage,
      choices: [{ finish_reason: "stop", message: { content: '{}' } }] }) }));
  }
  assert.equal(job.deepseekUsage?.requests, 3); assert.equal(job.deepseekUsage?.reportedRequests, 0);
  await withDeepSeekUsage(job, () => jsonCompletion({ ...options, fetcher: async () => envelope(100, '{}', 'stop', 'unknown-model') }));
  assert.equal(job.deepseekUsage?.unpricedRequests, 1);
  assert.equal(job.deepseekUsage?.totalTokens, 110);
  assert.equal(deepseekCost('constructor', 1, 1), undefined);
  await assert.rejects(withDeepSeekUsage(job, () => jsonCompletion({ ...options, maxAttempts: 1, fetcher: async () => { throw new Error('connection lost'); } })));
  assert.equal(job.deepseekUsage?.requests, 5); assert.equal(job.deepseekUsage?.reportedRequests, 1);
});

test("USD estimates distinguish cached input and output, aliases and tiny nonzero costs", async () => {
  assert.deepEqual(deepseekCost('deepseek-v4-flash', 1_000_000, 1_000_000, 1_000_000), { min: .603, max: 1.206 });
  assert.deepEqual(deepseekCost('deepseek-v4-pro', 1_000_000, 1_000_000, 0), { min: 2.64, max: 5.28 });
  assert.deepEqual(deepseekCost('deepseek-flash', 1_000_000, 0), { min: .003, max: .3 });
  assert.equal(formatUsageUsd(.000002), '<$0.0001');
  const job = owner();
  await withDeepSeekUsage(job, () => jsonCompletion({ ...options, fetcher: async () => Response.json({
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } },
    choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  }) }));
  assert.equal(job.deepseekUsage?.cachedInputTokens, 60);
});
