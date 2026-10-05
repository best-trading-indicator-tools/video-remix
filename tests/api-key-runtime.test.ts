import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

test("saved keys update live capabilities and provider requests without changing the environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-api-key-runtime-"));
  const names = ["DATA_DIR", "AUTO_AI", "DEEPSEEK_API_KEY", "PIXABAY_API_KEY", "PEXELS_API_KEY", "POSTIZ_API_KEY", "POSTIZ_API_URL", "DEEPSEEK_MODEL", "DEEPSEEK_TEXT_MODEL"];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { DATA_DIR: directory, AUTO_AI: "true", DEEPSEEK_API_KEY: "", PIXABAY_API_KEY: "", PEXELS_API_KEY: "",
    POSTIZ_API_KEY: "", POSTIZ_API_URL: "https://api.postiz.com/public/v1", DEEPSEEK_MODEL: "deepseek-flash", DEEPSEEK_TEXT_MODEL: "deepseek-flash" });
  try {
    globalThis.fetch = async () => { throw new Error("No external requests allowed"); };
    const { apiKeys } = await import("../server/api-keys.js");
    const { getAutoCapabilities } = await import("../server/auto.js");
    const { generateEditorialJSON } = await import("../server/editorial-provider.js");
    const { PostizClient } = await import("../server/postiz.js");
    await apiKeys.initialize();
    const before = await getAutoCapabilities();
    assert.equal(before.intelligence, false); assert.equal(before.stockBroll, false);
    await apiKeys.update("deepseek", "saved-ai-key");
    await apiKeys.update("pexels", "saved-stock-key");
    await apiKeys.update("postiz", "saved-publishing-key");
    const after = await getAutoCapabilities();
    assert.equal(after.intelligence, true); assert.equal(after.brollAI, true);
    assert.deepEqual(after.stockProviders, ["pexels"]);
    assert.equal(process.env.DEEPSEEK_API_KEY, ""); assert.equal(process.env.PEXELS_API_KEY, ""); assert.equal(process.env.POSTIZ_API_KEY, "");
    let requests = 0;
    globalThis.fetch = async (input, init) => {
      requests++;
      assert.equal(String(input), "https://api.deepseek.com/chat/completions");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer saved-ai-key");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"chosen":1}' } }] });
    };
    assert.deepEqual(await generateEditorialJSON({ prompt: {}, schema: z.object({ chosen: z.number() }), signal: new AbortController().signal }), { chosen: 1 });
    const publishing = new PostizClient(undefined, async (input, init) => {
      requests++;
      assert.equal(String(input), "https://api.postiz.com/public/v1/integrations");
      assert.equal(new Headers(init?.headers).get("Authorization"), "saved-publishing-key");
      return Response.json([]);
    });
    assert.deepEqual(await publishing.channels(), []); assert.equal(requests, 2);
    await apiKeys.update("deepseek", null); await apiKeys.update("pexels", null);
    const removed = await getAutoCapabilities();
    assert.equal(removed.intelligence, false); assert.equal(removed.brollAI, false); assert.equal(removed.stockBroll, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
    await rm(directory, { recursive: true, force: true });
  }
});
