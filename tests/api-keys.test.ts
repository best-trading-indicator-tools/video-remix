import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { ApiKeyStore } from "../server/api-keys.js";
import { installApiKeyRoutes } from "../server/api-key-routes.js";
import { diagnosticMiddleware } from "../server/diagnostics.js";

test("API key overrides are encrypted, persist, and preserve environment credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-api-keys-"));
  const environment = { DEEPSEEK_API_KEY: "original-owner-key" };
  const original = { ...environment };
  const vault = path.join(directory, "private", "api-keys.enc");
  const keyFile = path.join(directory, "private", "api-keys.key");
  try {
    const store = new ApiKeyStore(directory, environment);
    await store.initialize();
    assert.deepEqual(await readdir(directory), [], "reading settings creates no secret files");
    assert.equal(store.get("deepseek"), original.DEEPSEEK_API_KEY);
    assert.equal(store.status().providers[0].source, "environment");
    await Promise.all([store.update("deepseek", "saved-deepseek-key"), store.update("pexels", "saved-pexels-key")]);
    await store.update("pixabay", "saved-pixabay-key");
    await store.update("postiz", "saved-postiz-key");
    assert.deepEqual(environment, original);
    const encrypted = await readFile(vault);
    for (const secret of ["original-owner-key", "saved-deepseek-key", "saved-pexels-key", "saved-pixabay-key", "saved-postiz-key"]) {
      assert.ok(!encrypted.includes(Buffer.from(secret)));
      assert.ok(!JSON.stringify(store.status()).includes(secret));
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(vault)).mode & 0o777, 0o600);
      assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    }
    const restarted = new ApiKeyStore(directory, environment);
    await restarted.initialize();
    assert.equal(restarted.get("deepseek"), "saved-deepseek-key");
    assert.equal(restarted.get("pexels"), "saved-pexels-key");
    await restarted.update("deepseek", null);
    await restarted.update("pexels", null);
    assert.equal(restarted.get("deepseek"), "original-owner-key");
    assert.equal(restarted.get("pexels"), "");
    const again = new ApiKeyStore(directory, environment);
    await again.initialize();
    assert.equal(again.get("deepseek"), "original-owner-key");
    assert.equal(again.get("pixabay"), "saved-pixabay-key");
    assert.equal(again.get("postiz"), "saved-postiz-key");
    await assert.rejects(again.update("deepseek", "   "));
    assert.equal(again.get("deepseek"), "original-owner-key");
    assert.deepEqual(environment, original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unreadable vaults, missing encryption keys, and failed writes preserve existing credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-api-keys-failure-"));
  const vault = path.join(directory, "private", "api-keys.enc");
  const keyFile = path.join(directory, "private", "api-keys.key");
  try {
    const store = new ApiKeyStore(directory, {});
    await store.initialize(); await store.update("deepseek", "keep-this-key");
    const encrypted = await readFile(vault), key = await readFile(keyFile);
    await rm(keyFile);
    await assert.rejects(store.update("deepseek", "new-key"));
    assert.deepEqual(await readFile(vault), encrypted);
    assert.equal(store.get("deepseek"), "keep-this-key");
    const locked = new ApiKeyStore(directory, {});
    await assert.rejects(locked.initialize(), /Cannot unlock/);
    await assert.rejects(locked.update("deepseek", "new-key"), /not ready/);
    await writeFile(keyFile, key);
    const corrupt = Buffer.from(encrypted); corrupt[corrupt.length - 1] ^= 1;
    await writeFile(vault, corrupt);
    await assert.rejects(locked.initialize(), /Cannot unlock/);
    assert.deepEqual(await readFile(vault), corrupt);
    await rm(vault); await mkdir(vault);
    await assert.rejects(store.update("deepseek", "new-key"));
    assert.equal(store.get("deepseek"), "keep-this-key");
    assert.deepEqual((await readdir(path.dirname(vault))).sort(), ["api-keys.enc", "api-keys.key"]);
    await rm(vault, { recursive: true }); await writeFile(vault, encrypted);
    await store.update("deepseek", "recovered-key");
    assert.equal(store.get("deepseek"), "recovered-key");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("API key routes return status only, reject cross-origin writes, and never echo secrets in errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-api-key-routes-"));
  const store = new ApiKeyStore(directory, { DEEPSEEK_API_KEY: "owner-private-key" });
  await store.initialize();
  const app = express(); app.use(diagnosticMiddleware); installApiKeyRoutes(app, store);
  const server = createServer(app);
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint = `${base}/api/settings/api-keys`;
  const headers = { "Content-Type": "application/json", "X-Remix-Settings": "1", Origin: base };
  const secret = "replacement-private-key";
  try {
    const before = await (await fetch(endpoint)).text();
    assert.ok(!before.includes("owner-private-key")); assert.match(before, /environment/);
    const blocked = await fetch(`${endpoint}/deepseek`, { method: "PUT", headers: { ...headers, Origin: "http://localhost:9999" }, body: JSON.stringify({ apiKey: secret }) });
    assert.equal(blocked.status, 403);
    const missingHeader = await fetch(`${endpoint}/deepseek`, { method: "DELETE" });
    assert.equal(missingHeader.status, 403);
    assert.equal(store.get("deepseek"), "owner-private-key");
    const saved = await fetch(`${endpoint}/deepseek`, { method: "PUT", headers, body: JSON.stringify({ apiKey: secret }) });
    assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(secret));
    assert.equal(store.get("deepseek"), secret);
    for (const body of [JSON.stringify({ apiKey: "" }), JSON.stringify({ apiKey: `${secret}\nbad` }), `{"apiKey":"${secret}" broken}`, JSON.stringify({ apiKey: secret.repeat(1000) })]) {
      const invalid = await fetch(`${endpoint}/deepseek`, { method: "PUT", headers, body });
      assert.ok([400, 413].includes(invalid.status));
      assert.ok(!(await invalid.text()).includes(secret));
      assert.equal(store.get("deepseek"), secret);
    }
    const unknown = await fetch(`${endpoint}/other`, { method: "PUT", headers, body: JSON.stringify({ apiKey: secret }) });
    assert.equal(unknown.status, 400);
    const removed = await fetch(`${endpoint}/deepseek`, { method: "DELETE", headers });
    assert.equal(removed.status, 200);
    assert.equal(store.get("deepseek"), "owner-private-key");
    assert.equal(removed.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
