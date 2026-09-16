import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { ExportHistoryEntry } from "../shared/types.js";

test("history pages search the whole ledger, bound response sizes and keep publication edits durable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "history-pages-"));
  process.env.DATA_DIR = directory;
  const { initStore, saveStore, state } = await import("../server/store.js");
  const { createApp } = await import("../server/app.js");
  await initStore();
  state.history = Array.from({ length: 125 }, (_, index): ExportHistoryEntry => ({
    id: `history-${String(index).padStart(3, "0")}`, jobId: `job-${index}`, sourceId: "source", sourceFingerprint: "same-source", sourceName: "Source video",
    title: index === 1 ? "Unique older result" : `Export ${index}`, createdAt: "2026-09-16T10:00:00.000Z", cuts: [{ start: 0, end: 10 }], sourceText: "An idea",
    outputDuration: 10, revision: 1, publications: [], stockShots: [{ identity: "pixabay:1", name: "shot", sourceStart: 0, duration: 2 }],
  }));
  await saveStore();
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const page = async (query = "") => (await fetch(`${base}/api/history${query}`)).json();
  try {
    const first = await page();
    assert.equal(first.entries.length, 50); assert.equal(first.total, 125);
    assert.equal(first.stockUses["pixabay:1"], 125, "Shot reuse counts include other pages");
    const second = await page("?offset=50");
    assert.equal(second.entries.length, 50);
    assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, 100, "Equal timestamps have stable non-overlapping pages");
    assert.equal((await page("?offset=100")).entries.length, 25);
    const found = await page("?search=unique%20older");
    assert.equal(found.total, 1); assert.equal(found.entries[0].id, "history-001");
    assert.equal((await page("?search=%25")).total, 0, "SQL wildcard characters are literal search text");
    const finalPage = await page("?offset=9999");
    assert.equal(finalPage.offset, 100); assert.equal(finalPage.entries.length, 25);
    for (const query of ["limit=0", "limit=101", "limit=1.2", "offset=-1", "limit[]=10", "search=" + "a".repeat(201)])
      assert.equal((await fetch(`${base}/api/history?${query}`)).status, 400);
    const publications = [{ platform: "instagram", account: "retained", publishedAt: "2026-09-16T11:00:00.000Z" }];
    const result = await fetch(`${base}/api/history/history-001`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publications }) });
    assert.equal(result.status, 200); assert.deepEqual((await result.json()).publications, publications);
    await initStore();
    assert.deepEqual((await page("?search=unique%20older")).entries[0].publications, publications);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
