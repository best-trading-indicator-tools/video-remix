import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Transcript } from "../shared/types.js";
import { buildIdeaContext, discoverSourceIdeas, novelIdeaCandidates } from "../server/source-ideas.js";
import { selectSpeechCuts } from "../server/auto-plan.js";
import { config } from "../server/config.js";

const transcript: Transcript = { language: "en", duration: 40, segments: [
  { start: 0, end: 2, text: "Welcome back to the show.", words: [] },
  { start: 6, end: 8, text: "How can I take sharper photos?", words: [] },
  { start: 9, end: 11, text: "A faster shutter speed reduces motion blur.", words: [] },
  { start: 12, end: 14, text: "However, it does not correct missed focus.", words: [] },
  { start: 22, end: 25, text: "Use a tripod to hold the camera still.", words: [] },
  { start: 30, end: 32, text: "Please subscribe for the next episode.", words: [] },
] };
const idea = (overrides: Record<string, unknown> = {}) => ({ firstUnit: 1, lastUnit: 3,
  kind: "question-answer", setupUnit: 1, payoffUnit: 2, qualificationUnits: [3],
  summary: "A question, its shutter-speed answer and the focus limitation", ...overrides });
const largeTranscript = (): Transcript => ({ language: "en", duration: 3000,
  segments: Array.from({ length: 1000 }, (_, index) => ({ start: index * 3, end: index * 3 + 2,
    text: `Independent source unit ${index} explains a specific practical lesson.`, words: [] })) });

test("source context covers ordinary material and bounds sampled sections across a huge source", () => {
  const ordinary = buildIdeaContext(transcript, 40, 15);
  assert.equal(ordinary.coverage.full, true);
  assert.equal(ordinary.coverage.reviewedUnits, transcript.segments.length);
  const huge = buildIdeaContext(largeTranscript(), 3000, 15);
  assert.equal(huge.batches.length, 3);
  assert.equal(huge.coverage.full, false);
  assert.ok(huge.coverage.reviewedUnits <= 150);
  assert.equal(huge.batches[0]![0]!.id, 0);
  assert.equal(huge.batches.at(-1)!.at(-1)!.id, 999);
  assert.ok(huge.batches[1]![0]!.id > 350 && huge.batches[1]![0]!.id < 650);
  for (const batch of huge.batches) {
    assert.ok(batch.length <= 50);
    assert.ok(batch.reduce((sum, unit) => sum + JSON.stringify(unit).length, 0) <= 12000);
    assert.ok(batch.every((unit, index) => !index || unit.id === batch[index - 1]!.id + 1));
  }
});

test("DeepSeek idea discovery uses validated source anchors, bounded requests, caching and honest fallbacks", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "source-ideas-"));
  const oldEnabled = config.aiEnabled;
  const savedEnvironment = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_TEXT_MODEL: process.env.DEEPSEEK_TEXT_MODEL };
  config.aiEnabled = true;
  Object.assign(process.env, { DEEPSEEK_API_KEY: "source-ideas-test-key", DEEPSEEK_TEXT_MODEL: "editorial-test-model" });
  let replies: unknown[] = [];
  let calls: { prompt: string; max_tokens: number; model: string }[] = [];
  let interrupt: AbortController | undefined;
  let fail = false;
  const mocked = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assert.equal(String(input), "https://api.deepseek.com/chat/completions", "Discovery uses only the fixed DeepSeek endpoint");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer source-ideas-test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, "json_object");
    assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ["system", "user"]);
    const supplied = JSON.parse(body.messages[1].content);
    assert.ok(supplied.outputSchema, "The request carries the strict response contract");
    calls.push({ ...body, prompt: JSON.stringify(supplied.input) });
    if (interrupt) { interrupt.abort(); init?.signal?.throwIfAborted(); }
    if (fail) throw new Error("Test provider unavailable");
    assert.ok(replies.length, "Exceeded the planned model request budget");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(replies.shift()) } }] });
  });
  const options = (name: string) => ({ transcript, sourceDuration: 40, targetDuration: 15,
    signal: new AbortController().signal, cacheDir: path.join(directory, name) });
  try {
    await t.test("retains the question, answer and caveat, with only original words and times", async () => {
      replies = [{ ideas: [idea()] }]; calls = [];
      const result = await discoverSourceIdeas(options("grounded"));
      assert.equal(calls.length, 1);
      assert.equal(result.analyzed, true);
      assert.equal(result.coverage.full, true);
      assert.equal(result.noCompleteIdea, false);
      assert.equal(result.candidates.length, 1);
      const selected = result.candidates[0]!;
      assert.equal(selected.text, transcript.segments.slice(1, 4).map(segment => segment.text).join(" "));
      assert.equal(selected.start, 5.88);
      assert.equal(selected.end, 14.18);
      assert.ok(selected.end - selected.start < 15);
      assert.match(selected.context!.before, /Welcome/u);
      assert.match(selected.context!.after, /tripod/u);
      assert.ok(!selected.text.includes("tripod"));
      assert.equal(selected.idea!.kind, "question-answer");
      const prompt = JSON.parse(calls[0]!.prompt);
      assert.equal(prompt.units.length, 6);
      assert.match(calls[0]!.prompt, /qualification|payoff|unanswered question/u);
      assert.equal(calls[0]!.max_tokens, 1400 + 8192);
      const cached = await discoverSourceIdeas(options("grounded"));
      assert.deepEqual(cached, result);
      assert.equal(calls.length, 1, "The source analysis is reused across edits");
      const prior = [{ cuts: selectSpeechCuts(transcript, selected), text: selected.text }];
      assert.deepEqual(novelIdeaCandidates(cached.candidates, transcript, prior, 0), []);
    });

    await t.test("cached ideas are revalidated for changes in source text, language, target and model", async () => {
      calls = []; replies = Array.from({ length: 5 }, () => ({ ideas: [idea()] }));
      const args = options("identity");
      await discoverSourceIdeas(args);
      await discoverSourceIdeas(args);
      assert.equal(calls.length, 1);
      await discoverSourceIdeas({ ...args, targetDuration: 16 });
      await discoverSourceIdeas({ ...args, transcript: { ...transcript, language: "fr" } });
      const changed = structuredClone(transcript); changed.segments[2]!.text = "The replacement source explains a different claim.";
      const changedResult = await discoverSourceIdeas({ ...args, transcript: changed });
      assert.match(changedResult.candidates[0]!.text, /replacement source/u);
      process.env.DEEPSEEK_TEXT_MODEL = "another-editorial-test-model";
      await discoverSourceIdeas(args);
      assert.equal(calls.length, 5);
      assert.equal(calls.at(-1)!.model, "another-editorial-test-model");
      process.env.DEEPSEEK_TEXT_MODEL = "editorial-test-model";
    });

    await t.test("fast and thinking discovery never reuse each other's cached recommendations", async () => {
      const previous = process.env.DEEPSEEK_THINKING;
      try {
        calls = []; replies = [{ ideas: [idea()] }, { ideas: [] }];
        process.env.DEEPSEEK_THINKING = "true";
        const args = options("reasoning-identity");
        assert.equal((await discoverSourceIdeas(args)).candidates.length, 1);
        process.env.DEEPSEEK_THINKING = "false";
        assert.equal((await discoverSourceIdeas(args)).candidates.length, 0);
        assert.equal(calls.length, 2);
        assert.equal(calls[1]!.max_tokens, 1400);
        process.env.DEEPSEEK_THINKING = "true";
        assert.equal((await discoverSourceIdeas(args)).candidates.length, 1);
        assert.equal(calls.length, 2);
      } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_THINKING; else process.env.DEEPSEEK_THINKING = previous;
      }
    });

    await t.test("invalid IDs, omitted anchor spans, excessive durations and hallucinated timestamps never become cuts", async () => {
      const invalid = [
        idea({ firstUnit: 99, lastUnit: 100 }), idea({ firstUnit: 3, lastUnit: 1 }),
        idea({ payoffUnit: 5 }), idea({ qualificationUnits: [5] }), idea({ setupUnit: null }),
        idea({ firstUnit: 1, lastUnit: 1, payoffUnit: 1, qualificationUnits: [] }),
        idea({ lastUnit: 5 }), idea({ start: 0, end: 40 }),
      ];
      for (const [index, proposal] of invalid.entries()) {
        replies = [{ ideas: [proposal] }];
        const result = await discoverSourceIdeas(options(`invalid-${index}`));
        assert.deepEqual(result.candidates, []);
        assert.equal(result.noCompleteIdea, false, "An invalid suggestion is not evidence that no usable idea exists");
        assert.equal(result.analyzed, false);
        assert.ok(result.notes.length);
      }
    });

    await t.test("a complete empty assessment can recommend fewer shorts; sampled empty results cannot dismiss the whole source", async () => {
      calls = []; replies = [{ ideas: [] }];
      const none = await discoverSourceIdeas(options("empty"));
      assert.equal(none.analyzed, true);
      assert.equal(none.noCompleteIdea, true);
      assert.equal((await discoverSourceIdeas(options("empty"))).noCompleteIdea, true);
      assert.equal(calls.length, 1, "Empty valid results are cached too");
      replies = [{ ideas: [] }, { ideas: [] }, { ideas: [] }]; calls = [];
      const sampled = await discoverSourceIdeas({ ...options("sampled"), transcript: largeTranscript(), sourceDuration: 3000 });
      assert.equal(calls.length, 3);
      assert.equal(sampled.analyzed, true);
      assert.equal(sampled.noCompleteIdea, false);
      assert.match(sampled.notes.join(" "), /sampled .*1000.*not semantically assessed/u);
    });

    await t.test("a huge source cannot splice an idea across sections the model did not see", async () => {
      calls = []; replies = [
        { ideas: [idea({ firstUnit: 0, lastUnit: 501, setupUnit: 0, payoffUnit: 501, qualificationUnits: [] })] },
        { ideas: [] }, { ideas: [] },
      ];
      const result = await discoverSourceIdeas({ ...options("gaps"), transcript: largeTranscript(), sourceDuration: 3000 });
      assert.deepEqual(result.candidates, []);
      assert.equal(result.noCompleteIdea, false);
      assert.equal(calls.length, 3);
    });

    await t.test("AI disabled, missing credentials, provider failure and cancellation keep their different meanings", async () => {
      config.aiEnabled = false; calls = [];
      const unavailable = await discoverSourceIdeas(options("disabled"));
      assert.equal(calls.length, 0);
      assert.equal(unavailable.noCompleteIdea, false);
      assert.match(unavailable.notes.join(" "), /unavailable/u);
      config.aiEnabled = true; process.env.DEEPSEEK_API_KEY = "";
      const unconfigured = await discoverSourceIdeas(options("unconfigured"));
      assert.equal(calls.length, 0); assert.equal(unconfigured.analyzed, false); assert.equal(unconfigured.noCompleteIdea, false);
      process.env.DEEPSEEK_API_KEY = "source-ideas-test-key"; fail = true;
      const failed = await discoverSourceIdeas(options("failure"));
      assert.equal(failed.analyzed, false);
      assert.equal(failed.noCompleteIdea, false);
      await assert.rejects(readdir(options("failure").cacheDir), { code: "ENOENT" });
      fail = false;
      const before = new AbortController(); before.abort();
      const count = calls.length;
      await assert.rejects(discoverSourceIdeas({ ...options("before"), signal: before.signal }), { name: "AbortError" });
      assert.equal(calls.length, count);
      interrupt = new AbortController();
      await assert.rejects(discoverSourceIdeas({ ...options("during"), signal: interrupt.signal }), { name: "AbortError" });
      await assert.rejects(readdir(options("during").cacheDir), { code: "ENOENT" });
      interrupt = undefined;
    });
  } finally {
    mocked.mock.restore(); config.aiEnabled = oldEnabled;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
