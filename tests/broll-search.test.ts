import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planStockSearch } from "../server/broll-search.js";

type RequestBody = {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  thinking: unknown;
  response_format: unknown;
};
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as RequestBody;
const complete = (content: unknown) => Response.json({
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
});
const brief = (momentIndex = 1, query = "person working late laptop") => ({
  momentIndex,
  query,
  visual: "A person working at a laptop after dark",
  reason: "Illustrates work continuing into the evening",
});

// Only the text provider is mocked. Plans and their reusable caches use the
// production implementation; no live provider credentials or requests are used.
test("semantic stock searches use context, bounded provider work, and validated local caches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "broll-search-"));
  const original = {
    key: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL,
    textModel: process.env.DEEPSEEK_TEXT_MODEL,
  };
  const key = "private-stock-planner-test-key";
  process.env.DEEPSEEK_API_KEY = key;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_TEXT_MODEL;
  const moments = [
    { text: "The office day was over, but I kept answering emails." },
    { text: "I could not switch off after work." },
    { text: "I stayed at my laptop until late in the evening." },
  ];
  const options = (name: string) => ({
    moments,
    signal: new AbortController().signal,
    cacheDir: path.join(directory, name),
  });

  try {
    await t.test("an idiom receives neighboring speech and becomes a concrete visual search", async () => {
      let requests = 0;
      const result = await planStockSearch({
        ...options("idiom"),
        fetcher: async (input, init) => {
          requests++;
          assert.equal(input, "https://api.deepseek.com/chat/completions");
          assert.equal(init?.redirect, "error");
          assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${key}`);
          const body = bodyOf(init);
          assert.equal(body.model, "deepseek-flash");
          assert.deepEqual(body.response_format, { type: "json_object" });
          assert.deepEqual(body.thinking, { type: "disabled" });
          assert.ok(body.max_tokens <= 1400);
          assert.match(body.messages[0]!.content, /neighboring context/i);
          assert.match(body.messages[0]!.content, /untrusted data/i);
          assert.match(body.messages[0]!.content, /English stock search/i);
          assert.match(body.messages[0]!.content, /alternateQueries/i);
          assert.match(body.messages[0]!.content, /truthful contextual illustration/i);
          const prompt = JSON.parse(body.messages[1]!.content);
          assert.equal(prompt.language, "en");
          assert.equal(prompt.moments[1].text, moments[1]!.text);
          assert.equal(prompt.moments[1].context, moments.map(moment => moment.text).join(" "));
          assert.ok(!JSON.stringify(body).includes(directory));
          return complete({ briefs: [brief()] });
        },
      });
      assert.equal(requests, 1);
      assert.deepEqual(result.briefs, [brief()]);
      assert.deepEqual(result.notes, []);
    });

    await t.test("non-English speech retains its language and context while the search is English", async () => {
      const result = await planStockSearch({
        ...options("french"),
        language: "fr",
        moments: [{
          text: "Je n'arrivais pas à décrocher après le travail.",
          context: "Je répondais encore aux messages professionnels tard le soir.",
        }],
        fetcher: async (_input, init) => {
          const body = bodyOf(init);
          const prompt = JSON.parse(body.messages[1]!.content);
          assert.equal(prompt.language, "fr");
          assert.match(prompt.moments[0].text, /décrocher/);
          assert.match(prompt.moments[0].context, /messages professionnels/);
          assert.match(body.messages[0]!.content, /English stock search/i);
          return complete({ briefs: [brief(0)] });
        },
      });
      assert.equal(result.briefs[0]!.query, "person working late laptop");
    });

    await t.test("long edits send at most 40 moments across the timeline and accept at most three searches", async () => {
      let requests = 0;
      const longMoments = Array.from({ length: 80 }, (_, index) => ({
        text: `Moment ${index} ${"word ".repeat(120)}`,
        context: "context ".repeat(300),
      }));
      const result = await planStockSearch({
        ...options("bounded"),
        moments: longMoments,
        fetcher: async (_input, init) => {
          requests++;
          const prompt = JSON.parse(bodyOf(init).messages[1]!.content);
          assert.equal(prompt.moments.length, 40);
          assert.ok(prompt.moments.some((moment: { momentIndex: number }) => moment.momentIndex >= 75));
          for (const moment of prompt.moments) {
            assert.ok(moment.text.length <= 500);
            assert.ok(moment.context.length <= 1500);
          }
          return complete({ briefs: [
            brief(prompt.moments[0].momentIndex),
            brief(prompt.moments[20].momentIndex, "person walking forest trail"),
            brief(prompt.moments[39].momentIndex, "train arriving at station"),
          ] });
        },
      });
      assert.equal(requests, 1);
      assert.equal(result.briefs.length, 3);
      const excessive = await planStockSearch({
        ...options("excessive"),
        fetcher: async () => complete({ briefs: [brief(), brief(), brief(), brief()] }),
      });
      assert.deepEqual(excessive.briefs, []);
      assert.match(excessive.notes.join(" "), /Original footage was kept/);
    });

    await t.test("malformed, unsafe, unknown, weakly structured and duplicate choices cannot force a search", async () => {
      const replies = [
        { briefs: "search anything" },
        { briefs: [{ ...brief(), query: "https://example.com/private" }] },
        { briefs: [{ ...brief(), reason: "Open /etc/passwd" }] },
        { briefs: [{ ...brief(), sourceStart: 9000 }] },
        { briefs: [{ ...brief(), alternateQueries: ["https://example.com/private"] }] },
        { briefs: [{ ...brief(), alternateQueries: ["office computer", "working laptop"] }] },
        { briefs: [brief(999)] },
      ];
      for (const [index, reply] of replies.entries()) {
        const result = await planStockSearch({
          ...options(`invalid-${index}`),
          fetcher: async () => complete(reply),
        });
        assert.deepEqual(result.briefs, [], `Reply ${index} must not trigger a literal-word fallback`);
        assert.match(result.notes.join(" "), /Original footage was kept/);
      }
      const brokenJSON = await planStockSearch({
        ...options("broken-json"),
        fetcher: async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "{broken" } }] }),
      });
      assert.deepEqual(brokenJSON.briefs, []);
      const truncated = await planStockSearch({
        ...options("truncated"),
        fetcher: async () => Response.json({ choices: [{ finish_reason: "length", message: { content: '{"briefs":[]}' } }] }),
      });
      assert.deepEqual(truncated.briefs, []);
      const duplicates = await planStockSearch({
        ...options("duplicates"),
        fetcher: async () => complete({ briefs: [brief(), brief(), brief(2, "PERSON WORKING LATE LAPTOP")] }),
      });
      assert.deepEqual(duplicates.briefs, [brief()]);
    });

    await t.test("one semantic alternative remains tied to its visual brief and duplicate query text is removed", async () => {
      const planned = { ...brief(), alternateQueries: ["office computer"] };
      const result = await planStockSearch({
        ...options("alternative"),
        fetcher: async () => complete({ briefs: [planned] }),
      });
      assert.deepEqual(result.briefs, [planned]);
      const duplicate = await planStockSearch({
        ...options("alternative-duplicate"),
        fetcher: async () => complete({ briefs: [{ ...brief(), alternateQueries: ["PERSON  WORKING LATE LAPTOP"] }] }),
      });
      assert.deepEqual(duplicate.briefs, [{ ...brief(), alternateQueries: [] }]);
    });

    await t.test("empty plans are valid reusable results and cached files omit credentials", async () => {
      for (const empty of [false, true]) {
        let requests = 0;
        const args = {
          ...options(empty ? "cache-empty" : "cache-result"),
          fetcher: (async () => {
            requests++;
            return complete({ briefs: empty ? [] : [brief()] });
          }) as typeof fetch,
        };
        const first = await planStockSearch(args);
        const second = await planStockSearch(args);
        assert.deepEqual(first.briefs, empty ? [] : [brief()]);
        assert.deepEqual(second.briefs, first.briefs);
        assert.equal(requests, 1, "A valid empty plan must also avoid repeat paid requests");
        const files = await readdir(args.cacheDir);
        assert.equal(files.length, 1);
        assert.ok(files.every(name => name.endsWith(".json")));
        for (const filename of files) {
          const persisted = await readFile(path.join(args.cacheDir, filename), "utf8");
          assert.ok(!persisted.includes(key));
          assert.ok(!persisted.includes(directory));
          assert.ok(!persisted.includes("Authorization"));
        }
      }
    });

    await t.test("context, language and text model changes invalidate a cached plan", async () => {
      const observed: string[] = [];
      process.env.DEEPSEEK_MODEL = "shared-test-model";
      process.env.DEEPSEEK_TEXT_MODEL = "text-test-model";
      const args = {
        ...options("invalidated"),
        moments: [{ text: moments[1]!.text, context: "Still answering messages at a laptop" }],
        fetcher: (async (_input, init) => {
          observed.push(bodyOf(init).model);
          return complete({ briefs: [brief(0)] });
        }) as typeof fetch,
      };
      try {
        await planStockSearch(args);
        await planStockSearch(args);
        assert.equal(observed.length, 1);
        await planStockSearch({ ...args, moments: [{ text: moments[1]!.text, context: "Trying to stop thinking about tomorrow's office work" }] });
        assert.equal(observed.length, 2);
        await planStockSearch({ ...args, language: "fr" });
        assert.equal(observed.length, 3);
        process.env.DEEPSEEK_TEXT_MODEL = "new-text-test-model";
        await planStockSearch(args);
        assert.deepEqual(observed, ["text-test-model", "text-test-model", "text-test-model", "new-text-test-model"]);
      } finally {
        delete process.env.DEEPSEEK_MODEL;
        delete process.env.DEEPSEEK_TEXT_MODEL;
      }
    });

    await t.test("missing credentials make no request and provider failures reveal no secrets", async () => {
      delete process.env.DEEPSEEK_API_KEY;
      const missing = await planStockSearch({
        ...options("missing-key"),
        fetcher: async () => assert.fail("No credentials must mean no network request"),
      });
      assert.deepEqual(missing.briefs, []);
      assert.match(missing.notes.join(" "), /API key/);
      process.env.DEEPSEEK_API_KEY = key;
      for (const [index, fetcher] of [
        async () => { throw new Error(`Private provider failure ${key} ${directory}`); },
        async () => new Response(`Private provider failure ${key}`, { status: 401 }),
      ].entries()) {
        const result = await planStockSearch({ ...options(`provider-failure-${index}`), fetcher });
        assert.deepEqual(result.briefs, []);
        assert.ok(!JSON.stringify(result).includes(key));
        assert.ok(!JSON.stringify(result).includes(directory));
        assert.ok(!JSON.stringify(result).includes("Private provider failure"));
      }
    });

    await t.test("pre-cancelled and in-flight operations reject cancellation without caching a result", async () => {
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await assert.rejects(planStockSearch({
        ...options("already-aborted"),
        signal: alreadyAborted.signal,
        fetcher: async () => assert.fail("A cancelled plan must not contact the provider"),
      }), { name: "AbortError" });

      const controller = new AbortController();
      const args = options("inflight-aborted");
      let entered!: () => void;
      const requestEntered = new Promise<void>(resolve => { entered = resolve; });
      const operation = planStockSearch({
        ...args,
        signal: controller.signal,
        fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
          entered();
        }),
      });
      const rejected = assert.rejects(operation, { name: "AbortError" });
      await requestEntered;
      controller.abort();
      await rejected;
      await assert.rejects(readdir(args.cacheDir), { code: "ENOENT" });
    });
  } finally {
    if (original.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original.key;
    if (original.model === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = original.model;
    if (original.textModel === undefined) delete process.env.DEEPSEEK_TEXT_MODEL;
    else process.env.DEEPSEEK_TEXT_MODEL = original.textModel;
    await rm(directory, { recursive: true, force: true });
  }
});
