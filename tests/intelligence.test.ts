import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../server/config.js";
import { writeCreativePlan, type Candidate } from "../server/intelligence.js";

const candidates: Candidate[] = [
  { start: 0, end: 12, text: "A kitten plays near the window. Pet owners can make space for safe indoor play." },
  { start: 100, end: 120, text: "Measure raw materials by weight. The laboratory separates milligrams from micrograms." },
  { start: 200, end: 225, text: "The carpenter checks the wood grain. Cutting along it can leave a smoother edge." },
];
type Reply = { value?: unknown; status?: number; raw?: string; fail?: Error; abort?: AbortController };
type RequestBody = {
  prompt: string; messages: { role: string; content: string }[]; format: { properties: Record<string, unknown> };
  temperature: number; model: string;
};
const packaging = (hook: string, narration = "") => ({ hook, callouts: [], narration });

test("creative editing separates candidate selection from grounded excerpt packaging", async (t) => {
  const oldFetch = globalThis.fetch;
  const oldEnabled = config.aiEnabled;
  const savedEnvironment = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_TEXT_MODEL: process.env.DEEPSEEK_TEXT_MODEL };
  config.aiEnabled = true;
  Object.assign(process.env, { DEEPSEEK_API_KEY: "creative-test-key", DEEPSEEK_TEXT_MODEL: "editorial-test-model" });
  let replies: Reply[] = [];
  let requests: RequestBody[] = [];
  const run = (responses: Reply[], narration = false, signal = new AbortController().signal) => {
    replies = [...responses]; requests = [];
    return writeCreativePlan(candidates, 3, "fr", narration, signal);
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.deepseek.com/chat/completions", "No alternate service may be called");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer creative-test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "editorial-test-model");
    assert.equal(body.response_format.type, "json_object");
    assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ["system", "user"]);
    const supplied = JSON.parse(body.messages[1].content);
    requests.push({ ...body, prompt: JSON.stringify(supplied.input), format: supplied.outputSchema } as RequestBody);
    const reply = replies.shift();
    assert.ok(reply, "The editing workflow made an unexpected extra model call");
    if (reply.abort) {
      reply.abort.abort(new Error("Cancelled while generating"));
      throw init?.signal?.reason;
    }
    if (reply.fail) throw reply.fail;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: reply.raw ?? JSON.stringify(reply.value) } }] }, { status: reply.status ?? 200 });
  };
  try {
    await t.test("the headline request sees only the selected excerpt, with no earlier response context", async () => {
      const result = await run([{ value: { windowIndex: 1 } }, { value: packaging("Comment mesurer les matières premières") }]);
      assert.equal(result?.windowIndex, 1);
      assert.equal(result?.hookRewritten, true);
      assert.equal(requests.length, 2);
      const selection = JSON.parse(requests[0]!.prompt);
      const headline = JSON.parse(requests[1]!.prompt);
      assert.deepEqual(selection.candidates.map((item: { transcript: string }) => item.transcript), candidates.map(item => item.text));
      assert.deepEqual(Object.keys(requests[0]!.format.properties), ["windowIndex"]);
      assert.equal(headline.selectedExcerpt.transcript, candidates[1]!.text);
      assert.equal(headline.selectedExcerpt.start, candidates[1]!.start);
      assert.ok(!("candidates" in headline));
      assert.doesNotMatch(requests[1]!.prompt, /kitten|Pet owners|carpenter|wood grain/u);
      assert.match(requests[1]!.prompt, /language \(fr\)|version 3/u);
      assert.equal(requests[1]!.temperature, 0.45);
      assert.deepEqual(requests[1]!.messages.map(message => message.role), ["system", "user"], "Packaging cannot inherit earlier assistant responses");
      assert.ok(!("windowIndex" in requests[1]!.format.properties), "Packaging cannot change the selected cut");
    });

    await t.test("invalid selections cannot produce a headline for a different or nonexistent candidate", async () => {
      for (const value of [{ windowIndex: 3 }, { windowIndex: -1 }, { windowIndex: 1.5 }, {}, { windowIndex: 1, hook: "Wrong phase" }]) {
        assert.equal(await run([{ value }]), null);
        assert.equal(requests.length, 1);
      }
      assert.equal(await run([{ raw: "{not JSON" }]), null);
      assert.equal(requests.length, 1);
    });

    await t.test("neighboring evidence informs selection but cannot enter the selected-excerpt packaging request", async () => {
      candidates[1]!.context = { before: "Earlier discussion explains the question.", after: "A later qualification must not become a new headline claim." };
      candidates[1]!.idea = { kind: "explanation", summary: "A source-grounded laboratory explanation", firstUnit: 8, lastUnit: 10 };
      try {
        await run([{ value: { windowIndex: 1 } }, { value: packaging("Measuring raw materials") }]);
        const selecting = JSON.parse(requests[0]!.prompt);
        assert.deepEqual(selecting.candidates[1].neighboringContext, candidates[1]!.context);
        assert.match(requests[0]!.prompt, /shorter complete idea/u);
        assert.doesNotMatch(requests[1]!.prompt, /Earlier discussion|later qualification|source-grounded laboratory/u);
        assert.equal(JSON.parse(requests[1]!.prompt).selectedExcerpt.transcript, candidates[1]!.text);
      } finally { delete candidates[1]!.context; delete candidates[1]!.idea; }
    });

    await t.test("packaging errors keep the chosen cut and use its own speech as the fallback headline", async () => {
      for (const failure of [
        { status: 503, value: {} }, { raw: "{broken" }, { value: {} },
        { value: packaging("   ") }, { fail: new Error("Model timed out") },
        { value: { ...packaging("A kitten plays near the window"), windowIndex: 0 } },
      ] satisfies Reply[]) {
        const result = await run([{ value: { windowIndex: 2 } }, failure], true);
        assert.deepEqual(result, {
          windowIndex: 2, hookRewritten: false, hook: "The carpenter checks the wood grain.", callouts: [], narration: "",
        });
        assert.equal(requests.length, 2);
      }
    });

    await t.test("copied narration is retried against the same excerpt without selecting again", async () => {
      const result = await run([
        { value: { windowIndex: 1 } },
        { value: packaging("Measuring raw materials", candidates[1]!.text) },
        { value: packaging("Measuring raw materials", "The lab measures the material by weight and distinguishes milligrams from micrograms.") },
      ], true);
      assert.equal(result?.windowIndex, 1);
      assert.ok(result?.narration.startsWith("The lab"));
      assert.equal(requests.length, 3);
      for (const request of requests.slice(1)) {
        const prompt = JSON.parse(request.prompt);
        assert.equal(prompt.selectedExcerpt.transcript, candidates[1]!.text);
        assert.equal(prompt.selectedExcerpt.narrationWordBudget, 38);
        assert.ok(!("candidates" in prompt));
        assert.doesNotMatch(request.prompt, /kitten|carpenter/u);
      }
      assert.match(requests[2]!.prompt, /prior narration copied/u);
      assert.equal(requests[2]!.temperature, 0.65);
    });

    await t.test("a second copied narration is discarded while retaining that excerpt's valid headline", async () => {
      const result = await run([
        { value: { windowIndex: 2 } },
        { value: packaging("Reading the wood grain", candidates[2]!.text) },
        { value: packaging("Reading the wood grain", candidates[2]!.text.toUpperCase()) },
      ], true);
      assert.equal(result?.windowIndex, 2);
      assert.equal(result?.hook, "Reading the wood grain");
      assert.equal(result?.hookRewritten, true);
      assert.equal(result?.narration, "");
      assert.equal(requests.length, 3);
    });

    await t.test("unrequested narration is discarded even if the model supplies it", async () => {
      const result = await run([{ value: { windowIndex: 1 } }, { value: packaging("Measuring materials", "Unrequested narration.") }]);
      assert.equal(result?.narration, "");
      assert.equal(requests.length, 2);
    });

    await t.test("cancellation propagates before, during selection, and during packaging", async () => {
      const before = new AbortController(); before.abort(new Error("Already cancelled"));
      await assert.rejects(run([], false, before.signal), /Already cancelled/u);
      assert.equal(requests.length, 0);
      const selecting = new AbortController();
      await assert.rejects(run([{ abort: selecting }], false, selecting.signal), /Cancelled while generating/u);
      assert.equal(requests.length, 1);
      const writing = new AbortController();
      await assert.rejects(run([{ value: { windowIndex: 1 } }, { abort: writing }], false, writing.signal), /Cancelled while generating/u);
      assert.equal(requests.length, 2);
    });

    await t.test("empty candidate lists never call the model", async () => {
      requests = [];
      assert.equal(await writeCreativePlan([], 1, "en", false, new AbortController().signal), null);
      assert.equal(requests.length, 0);
    });

    await t.test("disabled AI and missing credentials cannot call DeepSeek or fall back to another provider", async () => {
      config.aiEnabled = false;
      assert.equal(await run([]), null); assert.equal(requests.length, 0);
      config.aiEnabled = true; process.env.DEEPSEEK_API_KEY = "";
      assert.equal(await run([]), null); assert.equal(requests.length, 0);
      process.env.DEEPSEEK_API_KEY = "creative-test-key";
    });
  } finally {
    globalThis.fetch = oldFetch;
    config.aiEnabled = oldEnabled;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
