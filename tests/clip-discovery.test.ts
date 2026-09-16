import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildIdeaContext } from "../server/source-ideas.js";
import { discoveryRequestSchema, distinctSuggestions, findBestClips } from "../server/clip-discovery.js";
import { installClipDiscoveryRoutes } from "../server/clip-discovery-routes.js";
import { state, type StoredSource } from "../server/store.js";
import type { Transcript } from "../shared/types.js";

const transcript: Transcript = { language: "en", duration: 2000, segments: Array.from({ length: 220 }, (_, index) => ({
  start: index * 8, end: index * 8 + 6, text: `Complete useful idea number ${index}.`, words: [],
})) };
const options = discoveryRequestSchema.parse({ sourceId: "aacaa565-781a-440c-b0bf-8b76f167e0c8", minSeconds: 1, maxSeconds: 30, count: 20 });

test("discovery reviews sections beyond Auto sampling, caches them, and anchors model ranges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clips-test-"));
  let calls = 0;
  const generate = async ({ prompt, reasoning }: { prompt: unknown; reasoning?: string }) => {
    assert.equal(reasoning, "low", "Discovery requests thinking for semantic source selection");
    calls++;
    const units = (prompt as { units: { id: number }[] }).units;
    return { ideas: [{ firstUnit: units[0].id, lastUnit: units[0].id, kind: "statement", summary: "A complete useful idea.", setupUnit: null, payoffUnit: units[0].id, qualificationUnits: [] },
      { firstUnit: 99999, lastUnit: 99999, kind: "statement", summary: "Invented timing must be rejected.", setupUnit: null, payoffUnit: 99999, qualificationUnits: [] }] };
  };
  try {
    const full = buildIdeaContext(transcript, 2000, 30, true);
    assert.ok(full.batches.length > 3); assert.equal(full.coverage.full, true);
    assert.equal(buildIdeaContext(transcript, 2000, 30).coverage.full, false);
    const args = { transcript, sourceDuration: 2000, options, cacheDir: directory, signal: new AbortController().signal, generate };
    const result = await findBestClips(args);
    assert.equal(result.reviewedSections, full.batches.length); assert.equal(result.fullCoverage, true);
    assert.equal(result.clips.length, full.batches.length); assert.ok(result.clips.some(clip => clip.start > 1200));
    assert.ok(result.clips.every(clip => clip.end <= 2000 && clip.end - clip.start <= 30));
    const before = calls; assert.deepEqual(await findBestClips(args), result); assert.equal(calls, before);
    await findBestClips({ ...args, options: { ...options, prompt: "Different editorial brief" } });
    assert.ok(calls > before, "A changed brief cannot reuse incompatible recommendations");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("discovery discloses partial failures, retries failed sections, and respects cancellation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clips-partial-"));
  let calls = 0;
  try {
    const result = await findBestClips({ transcript, sourceDuration: 2000, options, cacheDir: directory, signal: new AbortController().signal,
      generate: async () => { if (++calls === 2) throw new Error("provider down"); return { ideas: [] }; } });
    assert.equal(result.fullCoverage, false); assert.ok(result.notes.some(note => note.includes("Section 2")));
    assert.equal(result.reviewedSections, result.totalSections - 1);
    const before = calls;
    const retried = await findBestClips({ transcript, sourceDuration: 2000, options, cacheDir: directory, signal: new AbortController().signal,
      generate: async () => { calls++; return { ideas: [] }; } });
    assert.equal(retried.fullCoverage, true); assert.equal(calls, before + 1);
    await assert.rejects(findBestClips({ transcript, sourceDuration: 2000, options, cacheDir: directory, signal: AbortSignal.abort() }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("discovery validates numbers and avoids repeated excerpts without consulting export history", () => {
  for (const patch of [{ count: 21 }, { count: 0 }, { minSeconds: 0 }, { maxSeconds: 1.2 }, { minSeconds: 40, maxSeconds: 30 }, { sourceId: "../file" }, { filePath: "/private" }])
    assert.equal(discoveryRequestSchema.safeParse({ ...options, ...patch }).success, false);
  const clips = [{ start: 0, end: 10, text: "First" }, { start: 1, end: 9, text: "Same" }, { start: 20, end: 28, text: "Second" }];
  assert.equal(distinctSuggestions(clips, options).length, 2);
  assert.deepEqual(distinctSuggestions(clips, { ...options, exclude: [{ start: 0, end: 10 }] }), [clips[2]]);
});

test("discovery API streams progress and results, validates source IDs and releases cancelled work", { timeout: 10000 }, async () => {
  const saved = state.sources;
  state.sources = [{ id: options.sourceId, duration: 2000, hasAudio: true } as StoredSource];
  const app = express(); app.use(express.json());
  let hold = false, cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  installClipDiscoveryRoutes(app, { transcript: async (_source, _directory, signal, progress) => {
    progress(50);
    if (hold) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { cancelled(); reject(signal.reason); }, { once: true }));
    return transcript;
  }, discover: async () => ({ clips: [], reviewedSections: 1, totalSections: 1, fullCoverage: true, notes: [] }) });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shorts/discover`;
  const post = (body: unknown, signal?: AbortSignal) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  try {
    assert.equal((await post({ ...options, filePath: "/private" })).status, 400);
    assert.equal((await post({ ...options, sourceId: "3f4509be-8c84-4cec-aa7c-0af38bd794d9" })).status, 404);
    const response = await post(options); assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events[0].type, "progress"); assert.equal(events.at(-1).type, "result");
    hold = true; const abort = new AbortController(); const stream = await post(options, abort.signal);
    assert.equal((await post(options)).status, 409); abort.abort();
    await assert.rejects(stream.text()); await cancellation;
    hold = false; await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await post(options)).status, 200);
  } finally { state.sources = saved; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("discovery retries a semantically unanchored response instead of treating it as no suitable clips", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clips-repair-"));
  let calls = 0;
  try {
    const result = await findBestClips({ transcript: { ...transcript, segments: transcript.segments.slice(0, 2) }, sourceDuration: 20, options, cacheDir: directory,
      signal: new AbortController().signal, generate: async () => ({ ideas: [{ firstUnit: 0, lastUnit: 1, kind: "explanation", summary: "A complete explanation.", setupUnit: ++calls === 1 ? null : 0, payoffUnit: 1, qualificationUnits: [] }] }) });
    assert.equal(calls, 2); assert.equal(result.clips.length, 1); assert.equal(result.fullCoverage, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
