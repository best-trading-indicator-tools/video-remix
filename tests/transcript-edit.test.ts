import { diagnosticMiddleware } from "../server/diagnostics.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { addTranscriptSelection, cutCoverage, findTranscriptWords, removeTranscriptSelection, selectionInterval, selectionTitle,
  transcriptWords, type TranscriptEvent } from "../shared/transcript-edit.js";
import { formatSourceClock, MAX_SHORT_CUTS, parseSourceClock, type ShortCut } from "../shared/shorts.js";
import type { Transcript } from "../shared/types.js";
import type { StoredSource } from "../server/store.js";

// Routes create temporary work folders; keep them out of the real workspace.
const dataRoot = await mkdtemp(path.join(os.tmpdir(), "remix-transcript-"));
process.env.DATA_DIR = path.join(dataRoot, "data");
const { installTranscriptRoutes } = await import("../server/transcript-routes.js");
const { cachedSourceTranscript } = await import("../server/auto.js");
const { state } = await import("../server/store.js");
const { paths } = await import("../server/config.js");
after(() => rm(dataRoot, { recursive: true, force: true }));

const word = (start: number, end: number, text: string, probability = 0.98) => ({ start, end, word: text, probability });
const transcript: Transcript = {
  language: "en", duration: 6,
  segments: [
    { start: 0.5, end: 3, text: "Hello there. This is the key idea.", words: [
      word(0.5, 0.8, " Hello"), word(0.85, 1.2, " there."), word(1.6, 1.8, " This"), word(1.85, 1.95, " is"),
      word(2, 2.1, " the"), word(2.15, 2.5, " key"), word(2.55, 3, " idea.")] },
    { start: 4, end: 4.8, text: "Remember it.", words: [word(4, 4.4, " Remember"), word(4.45, 4.8, " it.", 0.3), word(4.8, 4.8, " ")] },
  ],
};
const words = transcriptWords(transcript);
const cut = (id: string, start: number, end: number, extra: Partial<ShortCut> = {}): ShortCut =>
  ({ id, start: formatSourceClock(start), end: formatSourceClock(end), ...extra });
const near = (actual: { start: number; end: number }, start: number, end: number, message?: string) =>
  assert.ok(Math.abs(actual.start - start) < 1e-9 && Math.abs(actual.end - end) < 1e-9, message || `${actual.start}–${actual.end}`);
const seconds = (cuts: ShortCut[]) => cuts.map(item => [parseSourceClock(item.start), parseSourceClock(item.end)]);
const plays = (cuts: ShortCut[], index: number) =>
  seconds(cuts).some(([start, end]) => start! <= words[index]!.start && end! >= words[index]!.end);

test("transcript words are indexed in source order and unusable words are skipped", () => {
  assert.equal(words.length, 9);
  assert.deepEqual(words.map(item => item.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(words[7]!.text, " Remember");
  assert.equal(words[8]!.segment, 1);
});

test("a selection plays its words with air around them, without reaching a neighboring word", () => {
  near(selectionInterval(words, 2, 6, 6), 1.48, 3.2);
  const tight = selectionInterval(words, 3, 3, 6);
  assert.ok(tight.start > words[2]!.end && tight.start <= words[3]!.start);
  assert.ok(tight.end >= words[3]!.end && tight.end < words[4]!.start);
  near(selectionInterval(words, 6, 2, 6), 1.48, 3.2, "Backward selections match forward ones");
  near(selectionInterval(words, 0, 0, 6), 0.38, 0.825);
  assert.ok(Math.abs(selectionInterval(words, 8, 8, 6).end - 5) < 1e-9);
  assert.equal(selectionInterval(words, 8, 8, 4.9).end, 4.9, "The source end is never exceeded");
});

test("coverage shows which sequence plays each word and where each sequence starts", () => {
  const coverage = cutCoverage(words, [cut("a", 1.48, 3.2), cut("b", 0.38, 1.4), cut("bad", 5, 4)]);
  assert.deepEqual(coverage.sequence, [2, 2, 1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual([...coverage.starts], [[2, 1], [0, 2]]);
  assert.deepEqual(cutCoverage(words, [cut("a", 0, 6), cut("again", 1.5, 2.2)]).sequence.slice(0, 4), [1, 1, 1, 1],
    "A repeated moment keeps its first sequence number");
});

test("adding a selection appends one sequence and clears stale face tracks", () => {
  const tracked = cut("a", 0, 1, { focalPoint: { x: 0.3, y: 0.5 }, focusTrack: [{ time: 0, x: 0.3, y: 0.5 }] });
  const result = addTranscriptSelection([tracked], { start: 1.48, end: 3.2 }, "new");
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [{ id: "a", start: tracked.start, end: tracked.end, focalPoint: { x: 0.3, y: 0.5 } },
    { id: "new", start: "00:00:01.480", end: "00:00:03.200" }]);
  assert.match(addTranscriptSelection([], { start: 1, end: 1.02 }, "x") as string, /more speech/);
  const full = Array.from({ length: MAX_SHORT_CUTS }, (_, index) => cut(`c${index}`, index, index + 0.5));
  assert.match(addTranscriptSelection(full, { start: 1, end: 2 }, "x") as string, /up to 60/);
});

test("removing words splits the sequence in the neighboring pauses and keeps every other word", () => {
  const result = removeTranscriptSelection([cut("a", 0, 6, { focalPoint: { x: 0.7, y: 0.4 } })], words, 3, 4, () => "second");
  assert.ok(Array.isArray(result));
  assert.deepEqual(result.map(item => item.id), ["a", "second"]);
  assert.deepEqual(seconds(result), [[0, 1.825], [2.125, 6]]);
  assert.ok(result.every(item => item.focalPoint?.x === 0.7), "Both parts keep the manual framing");
  for (const index of [0, 1, 2, 5, 6, 7, 8]) assert.ok(plays(result, index), `Kept ${words[index]!.text}`);
  for (const index of [3, 4]) assert.ok(!plays(result, index), `Removed ${words[index]!.text}`);
});

test("removal trims or drops covered sequences and refuses results that cannot render", () => {
  const trimmed = removeTranscriptSelection([cut("a", 1.48, 3.2), cut("b", 3.5, 5)], words, 2, 4, () => "unused");
  assert.ok(Array.isArray(trimmed));
  assert.deepEqual(seconds(trimmed), [[2.125, 3.2], [3.5, 5]]);
  const dropped = removeTranscriptSelection([cut("a", 1.48, 3.2), cut("b", 3.5, 5)], words, 2, 6, () => "unused");
  assert.ok(Array.isArray(dropped));
  assert.deepEqual(dropped.map(item => item.id), ["b"]);
  assert.match(removeTranscriptSelection([cut("a", 1.48, 3.2)], words, 2, 6, () => "x") as string, /at least one sequence/);
  assert.match(removeTranscriptSelection([cut("a", 3.5, 5)], words, 2, 3, () => "x") as string, /not in this short/);
  const crowded = Array.from({ length: MAX_SHORT_CUTS }, (_, index) => index === 0 ? cut("whole", 0, 6) : cut(`c${index}`, 10 + index, 10.5 + index));
  assert.match(removeTranscriptSelection(crowded, words, 3, 4, () => "x") as string, /more than 60/);
});

test("finding words ignores case and accents, completes the last word and wraps around", () => {
  assert.deepEqual(findTranscriptWords(words, "KEY idea"), { first: 5, last: 6 });
  assert.deepEqual(findTranscriptWords(words, "rem"), { first: 7, last: 7 });
  assert.deepEqual(findTranscriptWords(words, "hello", 7), { first: 0, last: 0 });
  assert.equal(findTranscriptWords(words, "nothing here"), null);
  assert.equal(findTranscriptWords(words, "  "), null);
  const french = transcriptWords({ language: "fr", duration: 2, segments: [{ start: 0, end: 1, text: "Mon résumé", words: [word(0, 0.4, " Mon"), word(0.5, 1, " résumé")] }] });
  assert.deepEqual(findTranscriptWords(french, "resume"), { first: 1, last: 1 });
});

test("a new short is named after the first words of the selection", () => {
  assert.equal(selectionTitle(words, 2, 6), "This is the key idea");
  assert.equal(selectionTitle(words, 0, 8), "Hello there. This is the key idea");
  const chinese = transcriptWords({ language: "zh", duration: 2, segments: [{ start: 0, end: 1, text: "你好世界", words: [word(0, 0.4, "你好"), word(0.5, 1, "世界")] }] });
  assert.equal(selectionTitle(chinese, 0, 1), "你好世界", "Languages without spaces keep their words together");
});

test("the saved transcript is read only for the same source, size and speech model", async () => {
  const source = { id: "5a2b7c1e-0d44-4f5e-9d61-2f4b8c9a7e10", size: 1234, duration: 6 } as StoredSource;
  assert.equal(await cachedSourceTranscript(source), null);
  await mkdir(paths.analysis, { recursive: true });
  await writeFile(path.join(paths.analysis, `${source.id}.json`), JSON.stringify({ key: `v1:${process.env.WHISPER_MODEL || "small"}:1234:6`, transcript }));
  assert.deepEqual(await cachedSourceTranscript(source), transcript);
  assert.equal(await cachedSourceTranscript({ ...source, size: 999 }), null, "A different file never reuses the transcript");
});

test("transcript routes return saved speech and stream a fresh local transcription", async () => {
  const id = "0f1e2d3c-4b5a-4c6d-8e7f-a0b1c2d3e4f5", silent = "1f1e2d3c-4b5a-4c6d-8e7f-a0b1c2d3e4f5";
  const saved = state.sources;
  state.sources = [{ id, duration: 6, hasAudio: true } as StoredSource, { id: silent, duration: 6, hasAudio: false } as StoredSource];
  let release!: () => void, calls = 0, fail = false, modelReady = true;
  const app = express();
  app.use(diagnosticMiddleware);
  app.use(express.json());
  installTranscriptRoutes(app, {
    cached: async () => null,
    transcribe: async (_source, _directory, signal, onProgress) => {
      calls++; onProgress(40);
      await new Promise<void>(resolve => { release = resolve; });
      signal.throwIfAborted();
      if (fail) throw new Error("model crashed");
      return transcript;
    },
    available: async () => modelReady,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shorts/transcript`;
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const events = async (response: Response) => (await response.text()).trim().split("\n").map(line => JSON.parse(line) as TranscriptEvent);
  const waitForCall = async (count: number) => { while (calls < count) await new Promise(resolve => setTimeout(resolve, 5)); };
  try {
    assert.equal((await fetch(`${url}/${crypto.randomUUID()}`)).status, 404);
    assert.deepEqual(await (await fetch(`${url}/${silent}`)).json(), { transcript: null });
    assert.deepEqual(await (await fetch(`${url}/${id}`)).json(), { transcript: null });
    assert.equal((await post({ sourceId: id, filePath: "/private/source" })).status, 400);
    assert.equal((await post({ sourceId: crypto.randomUUID() })).status, 404);
    assert.equal((await post({ sourceId: silent })).status, 422);

    const first = post({ sourceId: id });
    await waitForCall(1);
    const duplicate = await post({ sourceId: id });
    assert.equal(duplicate.status, 409, "One preparation runs per source");
    release();
    const response = await first;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    const stream = await events(response);
    assert.deepEqual(stream.filter(event => event.type === "progress").map(event => event.type === "progress" && event.progress), [1, 40]);
    assert.deepEqual(stream.at(-1), { type: "result", transcript });

    fail = true; modelReady = false;
    const broken = post({ sourceId: id });
    await waitForCall(2); release();
    const failure = (await events(await broken)).at(-1);
    assert.equal(failure?.type, "error");
    if (failure?.type === "error") {
      assert.ok(failure.diagnostic?.requestId);
      assert.equal(failure.diagnostic?.entityId, id);
      assert.equal(failure.diagnostic?.code, "TRANSCRIPTION_NOT_READY");
    }
    assert.match(failure?.type === "error" ? failure.message : "", /npm run setup:auto/);
  } finally {
    state.sources = saved;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
