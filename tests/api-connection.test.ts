import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiConnectionService } from "../server/api-connection.js";
import { ApiKeyStore } from "../server/api-keys.js";
import { installApiKeyRoutes } from "../server/api-key-routes.js";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

test("connection checks only read provider access, distinguish empty balances and cache stock checks", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const service = new ApiConnectionService(async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    return Response.json(url.hostname === "api.deepseek.com" ? { is_available: init?.headers && new Headers(init.headers).get("Authorization") !== "Bearer empty", balance_infos: [{ currency: "USD", total_balance: "0.00" }] }
      : url.hostname === "pixabay.com" ? { total: 0, hits: [] }
        : url.hostname === "api.pexels.com" ? { total_results: 0, videos: [] } : []);
  });
  assert.equal((await service.check("deepseek", "")).status, "missing");
  assert.equal(calls.length, 0);
  assert.equal((await service.check("deepseek", "empty")).status, "no-credit");
  assert.equal((await service.check("deepseek", "funded")).status, "ready");
  for (const provider of ["pixabay", "pexels", "postiz"] as const) assert.equal((await service.check(provider, "private-key")).status, "ready");
  assert.equal(calls.length, 5);
  await service.check("pixabay", "private-key");
  assert.equal(calls.length, 5);
  await service.check("pixabay", "changed-key");
  assert.equal(calls.length, 6, "changed credentials must be checked again");
  assert.equal(calls[2].url.pathname, "/api/videos/");
  assert.equal(calls[2].url.searchParams.get("key"), "private-key");
  assert.equal(calls[3].url.pathname, "/v1/videos/search");
  for (const { url, init } of calls) { assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.body, undefined); assert.ok(!url.pathname.includes("completions")); }
});

test("provider errors, invalid bodies and timeouts are actionable and never disclose credentials", async () => {
  for (const [code, expected] of [[401, "invalid"], [403, "invalid"], [402, "no-credit"], [429, "rate-limited"], [500, "unavailable"]] as const) {
    const service = new ApiConnectionService(async () => new Response("private-key", { status: code }));
    const response = await service.check("pexels", "private-key");
    assert.equal(response.status, expected); assert.ok(!JSON.stringify(response).includes("private-key"));
  }
  for (const payload of ["<html>private-key</html>", JSON.stringify({ error: "private-key" }), "a".repeat(256_001)]) {
    const service = new ApiConnectionService(async () => new Response(payload));
    assert.equal((await service.check("pixabay", "private-key")).status, "unavailable");
  }
  const service = new ApiConnectionService(() => new Promise(() => {}), 15);
  const first = service.check("deepseek", "private-key");
  assert.equal((await service.check("deepseek", "other-key")).status, "rate-limited");
  const result = await first;
  assert.equal(result.status, "unavailable"); assert.match(result.message, /timed out/);
});

test("test route accepts draft keys without saving and enforces same-origin write protection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-key-check-"));
  const store = new ApiKeyStore(directory, { PEXELS_API_KEY: "existing-private-key" }); await store.initialize();
  const sent: string[] = [];
  const service = new ApiConnectionService(async (_url, init) => {
    sent.push(new Headers(init?.headers).get("Authorization")!);
    return Response.json({ total_results: 0, videos: [] });
  });
  const app = express(); installApiKeyRoutes(app, store, service);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `${base}/api/settings/api-keys/pexels/test`;
  const headers = { "Content-Type": "application/json", "X-Remix-Settings": "1", Origin: base };
  try {
    for (const requestHeaders of [{ ...headers, Origin: "https://example.com" }, { "Content-Type": "application/json" }]) {
      assert.equal((await fetch(url, { method: "POST", headers: requestHeaders, body: "{}" })).status, 403);
    }
    assert.equal(sent.length, 0);
    const checked = await fetch(url, { method: "POST", headers, body: JSON.stringify({ apiKey: "draft-private-key" }) });
    assert.equal(checked.headers.get("cache-control"), "no-store");
    const body = await checked.json(); assert.equal(body.status, "ready"); assert.ok(!JSON.stringify(body).includes("private-key"));
    assert.equal(store.get("pexels"), "existing-private-key");
    assert.equal((await fetch(url, { method: "POST", headers, body: "{}" })).status, 200);
    assert.deepEqual(sent, ["draft-private-key", "existing-private-key"]);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ apiKey: "secret\ninvalid" }) })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
