import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type EditPlan } from "../shared/types.js";
import { fingerprintFile, historyEntry, previousEditorialPlans, publicationChangesSchema, upsertHistory } from "../server/history.js";
import { isRepeatedPlan } from "../server/diversity.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const fingerprint = createHash("sha256").update("same original source").digest("hex");
const source = (): StoredSource => ({
  id: "source-first-import", name: "Original.mp4", fingerprint, size: 1024,
  duration: 10, width: 1080, height: 1920, fps: 30, hasAudio: true,
  createdAt: "2026-09-15T10:00:00.000Z", thumbnailUrl: "/api/sources/source-first-import/thumbnail", url: "/api/sources/source-first-import/video",
  filePath: "/private/work/source.mp4", thumbnailPath: "/private/work/source.jpg",
});
const job = (): StoredJob => ({
  id: "completed-job", sourceId: "source-first-import", sourceName: "Original.mp4", batchId: "old-batch", variant: 1,
  status: "completed", progress: 100, outputPath: "/private/outputs/completed.mp4", captionPath: "/private/outputs/completed.srt",
  createdAt: "2026-09-15T10:05:00.000Z", finishedAt: "2026-09-15T10:06:00.000Z",
  settings: { ...DEFAULT_SETTINGS, segments: [{ start: 1, end: 3 }, { start: 5, end: 7 }], hookText: "A rewritten headline" },
  summary: { title: "Another rewritten headline", changes: [], sourceDuration: 10, outputDuration: 4, transcriptAvailable: true, usedAI: true, narration: false },
  sourceTranscript: { language: "en", duration: 10, segments: [
    { start: 0, end: 3, text: "Excluded Original speech", words: [{ start: 0, end: 1, word: "Excluded" }, { start: 1, end: 2, word: "Original" }, { start: 2, end: 3, word: "speech" }] },
    { start: 5, end: 7, text: "Second idea.", words: [{ start: 5, end: 6, word: "Second" }, { start: 6, end: 7, word: "idea." }] },
  ] },
  supportingVisuals: [{ kind: "broll", name: "Person using a laptop", start: 0.5, end: 2.5, sourceStart: 2.4,
    stock: { providerId: "pixabay:123", rendition: "https://cdn.pixabay.com/video/2026/123.mp4", contentHash: "clip-hash", retrievedAt: "2026-09-15T10:04:00.000Z", licenseUrl: "https://pixabay.com/service/license-summary/" },
  }],
});

test("history retains immutable settings and groups matching editing choices without conflating different filters", () => {
  const completed = job();
  const first = historyEntry(source(), completed)!;
  assert.equal(first.configuration?.settings.speed, completed.settings.speed);
  assert.equal(first.configuration?.actual.visualCoveragePercent, 50);
  completed.settings.hookText = "A different title";
  assert.equal(historyEntry(source(), completed)!.configuration?.profileId, first.configuration?.profileId);
  completed.settings.speed = 1.1;
  const changed = historyEntry(source(), completed)!;
  assert.notEqual(changed.configuration?.profileId, first.configuration?.profileId);
  assert.equal(upsertHistory([first], changed)[0]!.configuration?.settings.speed, 1, "Reconciliation cannot rewrite the original export settings");
  assert.equal(first.configuration?.settings.hookText, "A rewritten headline");
});

test("YouTube publications accept only platform URLs and preserve separate accounts", () => {
  const publishedAt = "2026-09-16T10:00:00Z";
  for (const url of ["https://youtube.com/shorts/example", "https://youtu.be/example"]) {
    assert.ok(publicationChangesSchema.safeParse({ publications: [{ platform: "youtube", publishedAt, url, account: "@creator" }] }).success);
  }
  for (const url of ["https://youtube.com.bad.test/shorts/a", "https://youtu.be:8080/a", "https://a:b@youtube.com/a", "https://instagram.com/reel/a"]) {
    assert.equal(publicationChangesSchema.safeParse({ publications: [{ platform: "youtube", publishedAt, url }] }).success, false);
  }
  const first = historyEntry(source(), job())!;
  first.publications = ["@one", "@two"].map(account => ({ platform: "youtube", publishedAt, account }));
  assert.equal(upsertHistory([first], first)[0]!.publications.length, 2);
});

test("content fingerprints survive rename, timestamp changes and reimport while changed bytes differ", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-fingerprint-"));
  try {
    const original = path.join(directory, "first.mp4");
    const renamed = path.join(directory, "renamed.mp4");
    const reimport = path.join(directory, "new-import.mp4");
    const bytes = Buffer.from("exactly the same source video bytes");
    await writeFile(original, bytes);
    const first = await fingerprintFile(original);
    assert.equal(first, createHash("sha256").update(bytes).digest("hex"));
    await rename(original, renamed);
    await utimes(renamed, new Date("2025-01-01"), new Date("2025-01-01"));
    await writeFile(reimport, bytes);
    assert.equal(await fingerprintFile(renamed), first);
    assert.equal(await fingerprintFile(reimport), first);
    await writeFile(reimport, Buffer.from("exactly the same source video byteZ"));
    assert.notEqual(await fingerprintFile(reimport), first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fingerprinting cancels before file access and during a real streaming read", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(fingerprintFile("/missing/must-not-be-opened.mp4", alreadyAborted.signal), { name: "AbortError" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-abort-"));
  try {
    const filePath = path.join(directory, "large-sparse-video.mp4");
    const file = await open(filePath, "w");
    try { await file.truncate(256 * 1024 * 1024); } finally { await file.close(); }
    const controller = new AbortController();
    const reading = fingerprintFile(filePath, controller.signal);
    const rejected = assert.rejects(reading, { name: "AbortError" });
    const timer = setTimeout(() => controller.abort(), 10);
    try { await rejected; } finally { clearTimeout(timer); }
    await rm(filePath);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only completed fingerprinted exports enter history with original speech and the used stock window", () => {
  const original = source();
  const completed = job();
  for (const status of ["queued", "processing", "failed", "cancelled", "skipped"] as const)
    assert.equal(historyEntry(original, { ...completed, status }), null);
  assert.equal(historyEntry({ ...original, fingerprint: undefined }, completed), null);
  const entry = historyEntry(original, completed)!;
  assert.equal(entry.id, completed.id);
  assert.equal(entry.jobId, completed.id);
  assert.equal(entry.sourceFingerprint, fingerprint);
  assert.equal(entry.sourceText, "Original speech Second idea.");
  assert.equal(entry.title, "Another rewritten headline");
  assert.ok(!entry.sourceText.includes("rewritten"));
  assert.equal(entry.createdAt, completed.finishedAt);
  assert.equal(entry.outputDuration, 4);
  assert.deepEqual(entry.stockShots, [{ identity: "pixabay:123", name: "Person using a laptop", sourceStart: 2.4, duration: 2 }]);
  assert.deepEqual(entry.publications, []);
  assert.ok(!JSON.stringify(entry).includes("/private/"));
  assert.ok(!JSON.stringify(entry).includes("filePath"));
  entry.cuts[0]!.start = 99;
  assert.equal(completed.settings.segments![0]!.start, 1, "History cannot mutate a saved export");
});

test("saved revision cuts and provenance take precedence and missing speech stays empty", () => {
  const completed = job();
  completed.editPlan = { cuts: [{ start: 5, end: 7 }], revision: 4 } as EditPlan;
  completed.parentJobId = "original-export";
  completed.summary = undefined;
  completed.settings.speed = 2;
  completed.supportingVisuals = [
    { kind: "broll", name: "Library clip", assetId: "library-asset", start: 0, end: 0.75, sourceStart: 1 },
    { kind: "graphic", name: "Title card", assetId: "generated-card", start: 0.75, end: 1 },
  ];
  const entry = historyEntry(source(), completed)!;
  assert.equal(entry.revision, 4);
  assert.equal(entry.parentJobId, "original-export");
  assert.deepEqual(entry.cuts, [{ start: 5, end: 7 }]);
  assert.equal(entry.sourceText, "Second idea.");
  assert.equal(entry.outputDuration, 1);
  assert.deepEqual(entry.stockShots, [{ identity: "library:library-asset", name: "Library clip", sourceStart: 1, duration: 0.75 }]);
  completed.sourceTranscript = undefined;
  assert.equal(historyEntry(source(), completed)!.sourceText, "");
});

test("legacy manual trims record the rendered source shift and valid rendition fallback", () => {
  const completed = job();
  completed.settings.segments = undefined;
  completed.settings.trimStart = 2;
  completed.settings.trimEnd = 6;
  completed.settings.timeShift = 1;
  completed.summary = undefined;
  completed.settings.speed = 2;
  completed.supportingVisuals![0]!.stock!.providerId = "";
  const entry = historyEntry(source(), completed)!;
  assert.deepEqual(entry.cuts, [{ start: 3, end: 7 }]);
  assert.equal(entry.outputDuration, 2);
  assert.equal(entry.stockShots[0]!.identity, "https://cdn.pixabay.com/video/2026/123.mp4");
  completed.supportingVisuals![0]!.stock!.rendition = "/private/work/stock.mp4";
  assert.deepEqual(historyEntry(source(), completed)!.stockShots, []);
});

test("history upserts are idempotent, preserve publication records, and remove repeated job IDs", () => {
  const entry = historyEntry(source(), job())!;
  const first = upsertHistory([], entry);
  first[0]!.publications.push({ platform: "instagram", publishedAt: "2026-09-15T11:00:00.000Z", url: "https://www.instagram.com/reel/example/" });
  const before = structuredClone(first);
  const updated = upsertHistory(first, { ...entry, title: "Updated saved title" });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.title, "Updated saved title");
  assert.deepEqual(updated[0]!.publications, before[0]!.publications);
  assert.deepEqual(first, before);
  assert.deepEqual(upsertHistory(updated, { ...entry, title: "Updated saved title" }), updated);
  assert.equal(upsertHistory([...updated, ...updated], entry).length, 1);
  updated[0]!.publications[0]!.url = "https://instagram.com/changed";
  assert.notEqual(updated[0]!.publications[0]!.url, first[0]!.publications[0]!.url);
});

test("repeat comparison survives deleted media and new source and batch IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-retention-"));
  const filePath = path.join(directory, "source.mp4");
  await writeFile(filePath, "temporary source bytes");
  const original = { ...source(), filePath, fingerprint: await fingerprintFile(filePath) };
  const entry = historyEntry(original, job())!;
  const durable = JSON.parse(JSON.stringify(upsertHistory([], entry)));
  await rm(directory, { recursive: true, force: true });
  const reimport = { ...original, id: "new-import-id", name: "Renamed import.mp4" };
  const previous = previousEditorialPlans(durable, reimport.fingerprint!);
  assert.equal(previous.length, 1);
  assert.ok(isRepeatedPlan({ cuts: [{ start: 1, end: 3 }, { start: 5, end: 7 }], text: "Original speech Second idea." }, previous));
  assert.deepEqual(previousEditorialPlans(durable, "different-content-hash"), []);
  previous[0]!.cuts[0]!.start = 99;
  assert.equal(durable[0].cuts[0].start, 1);
});

test("publication notes accept matching HTTPS platform links and reject unsafe or malformed input", () => {
  const publishedAt = "2026-09-15T11:00:00.000Z";
  for (const item of [
    { platform: "instagram", publishedAt, url: "https://instagram.com/p/example/" },
    { platform: "instagram", publishedAt, url: "https://www.instagram.com/reel/example/" },
    { platform: "tiktok", publishedAt, url: "https://vm.tiktok.com/example/" },
    { platform: "tiktok", publishedAt: "2026-09-15T13:00:00+02:00" },
  ]) assert.equal(publicationChangesSchema.safeParse({ publications: [item] }).success, true);
  for (const item of [
    { platform: "instagram", publishedAt, url: "https://tiktok.com/example" },
    { platform: "instagram", publishedAt, url: "https://instagram.com.attacker.example/post" },
    { platform: "instagram", publishedAt, url: "https://notinstagram.com/post" },
    { platform: "tiktok", publishedAt, url: "https://tiktok.com@attacker.example/post" },
    { platform: "instagram", publishedAt, url: "https://private:secret@instagram.com/post" },
    { platform: "instagram", publishedAt, url: "https://instagram.com:8080/post" },
    { platform: "instagram", publishedAt, url: "http://instagram.com/post" },
    { platform: "tiktok", publishedAt, url: "file:///private/video.mp4" },
    { platform: "tiktok", publishedAt, url: "javascript:alert(1)" },
    { platform: "tiktok", publishedAt, url: "not a URL" },
    { platform: "unsupported", publishedAt },
    { platform: "tiktok", publishedAt: "2026-02-30T00:00:00Z" },
    { platform: "tiktok", publishedAt: "yesterday" },
    { platform: "tiktok", publishedAt, filePath: "/private/video.mp4" },
  ]) assert.equal(publicationChangesSchema.safeParse({ publications: [item] }).success, false, JSON.stringify(item));
  assert.equal(publicationChangesSchema.safeParse({ publications: [], statePath: "/private/state.json" }).success, false);
  assert.equal(publicationChangesSchema.safeParse({ publications: Array.from({ length: 51 }, () => ({ platform: "tiktok", publishedAt })) }).success, false);
  assert.equal(publicationChangesSchema.safeParse({ publications: [] }).success, true);
});
