import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Transcript } from "../shared/types.js";
import { compareRenderedCaptions, finishedSamples, finishedTimeline } from "../shared/finished-review.js";
import { reviewFinishedVideo, type PictureEvidence } from "../server/finished-review.js";
import { AIRequestError } from "../server/ai-errors.js";
import { runLocal } from "../server/auto-process.js";

const speech = (text: string, probability = 0.99): Transcript => ({ duration: 4, language: "en", segments: [{ start: 0, end: 4, text,
  words: text.split(" ").map((word, index, all) => ({ word, start: index * 4 / all.length, end: (index + 1) * 4 / all.length, probability })) }] });
const caption = { id: "cue", start: 0, end: 4, text: "Please show the blue square on screen" };
const pass = (samples: PictureEvidence[]) => ({ samples: samples.map(sample => ({ id: sample.id, inspected: true, caption: null, issues: [] })) });

test("finished review clocks follow reordered cuts, speed and inserted footage", () => {
  const settings = { ...DEFAULT_SETTINGS, speed: 2, segments: [{ start: 20, end: 28 }, { start: 2, end: 6 }], ownFootage: [{
    id: "11111111-1111-4111-8111-111111111111", assetId: "22222222-2222-4222-8222-222222222222", mode: "insert" as const,
    at: 2, start: 0, end: 3, audio: "clip" as const, fit: "contain" as const,
  }] };
  const timeline = finishedTimeline(settings, 40, 30);
  assert.equal(timeline.duration, 9);
  assert.equal(timeline.sourceAt(1), 22);
  assert.equal(timeline.sourceAt(3), undefined, "An insert has no original source time");
  assert.equal(timeline.sourceAt(5.5), 25);
  assert.equal(timeline.sourceAt(8), 4);
  assert.deepEqual(timeline.retime([{ start: 1, end: 3, kind: "graphic" }]), [{ start: 1, end: 2, kind: "graphic" }, { start: 5, end: 6, kind: "graphic" }]);
  const prepared = finishedSamples(settings, 40, 30, [{ start: 3, end: 4, kind: "broll" }]);
  const stock = prepared.samples.find(sample => sample.visualKind === "broll")!;
  assert.equal(stock.at, 6.5); assert.equal(stock.sourceAt, 27);
  assert.equal(prepared.samples.find(sample => sample.visualKind === "own-insert")?.sourceAt, undefined);
  assert.deepEqual(prepared.captions([{ ...caption, start: 1, end: 3 }]).map(cue => [cue.start, cue.end]), [[1, 2], [5, 6]]);
  const shifted = finishedTimeline({ ...DEFAULT_SETTINGS, trimStart: 4, trimEnd: 8, timeShift: 2 }, 10, 30);
  assert.equal(shifted.sourceAt(1), 7);
});

test("caption comparison flags substantial disagreement without treating missing or low-confidence recognition as success", () => {
  assert.equal(compareRenderedCaptions([caption], speech(caption.text), [{ start: 0, end: 4 }]).compared, 1);
  assert.deepEqual(compareRenderedCaptions([caption], speech(caption.text), [{ start: 0, end: 4 }]).issues, []);
  assert.equal(compareRenderedCaptions([caption], speech("A different person walks into another room"), [{ start: 0, end: 4 }]).issues[0]?.check, "caption-speech");
  assert.equal(compareRenderedCaptions([caption], speech(caption.text, 0.2), [{ start: 0, end: 4 }]).compared, 0);
  assert.equal(compareRenderedCaptions([caption], speech(caption.text), [{ start: 2, end: 4 }]).compared, 0, "Partial audio windows cannot validate a whole caption");
  const missing = speech(caption.text); missing.segments[0]!.words = [];
  assert.equal(compareRenderedCaptions([caption], missing, [{ start: 0, end: 4 }]).compared, 0);
  const negative = { ...caption, text: "This method does not always work" };
  assert.equal(compareRenderedCaptions([negative], speech("This method does always work"), [{ start: 0, end: 4 }]).issues.length, 1, "Omitting a confident negation is a meaningful change even when most words agree");
});

test("finished review uses decoded export/source images and the rendered audio, caches transcription, and keeps failures advisory", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-finished-test-"));
  const output = path.join(directory, "output.mp4"), source = path.join(directory, "source.mp4");
  try {
    for (const [file, color] of [[source, "red"], [output, "blue"]]) await runLocal("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=${color}:size=320x180:rate=24`,
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", file!]);
    const bytes = await readFile(output);
    const input = { output, sourcePath: source, sourceDuration: 4, sourceFps: 24, settings: { ...DEFAULT_SETTINGS },
      visuals: [{ start: 1, end: 3, kind: "broll" as const, name: "Illustrative stock square" }], captions: [caption], workDir: directory, signal: new AbortController().signal };
    let transcriptions = 0;
    const transcriber = async (request: { input: string }) => {
      assert.equal(request.input, output, "Inspect the final soundtrack, not the original source or cached source transcript");
      transcriptions++; return speech("A different person walks into another room");
    };
    await t.test("findings carry actual output timestamps and paired picture evidence", async () => {
      const report = await reviewFinishedVideo({ ...input, cacheFile: path.join(directory, "audio-cache.json") }, { transcriber, vision: async samples => {
        const stock = samples.find(sample => sample.visualId)!;
        assert.equal(stock.at, 2); assert.equal(stock.sourceAt, 2);
        assert.match(stock.outputImage, /^data:image\/jpeg;base64,/u);
        assert.notEqual(stock.outputImage, stock.sourceImage);
        assert.match(stock.speech, /different person/u);
        return { samples: samples.map(sample => ({ id: sample.id, inspected: true, caption: null, issues: sample.visualId ? [
          { check: "demonstration-hidden", confidence: 0.95, message: "The red example is covered by the replacement.", evidence: "The source shows a red square; the export shows a blue square at this moment." },
          { check: "text-layout", confidence: 0.95, message: "Review the overlapping text in this sample.", evidence: "Two lines occupy the same visible location." },
        ] : [] })) };
      } });
      assert.equal(report.status, "review");
      assert.ok(report.issues.some(issue => issue.check === "caption-speech"));
      assert.ok(report.issues.some(issue => issue.check === "demonstration-hidden" && issue.start === 1.5));
      assert.equal(report.picture.frames, 3); assert.equal(report.picture.sourceFrames, 3);
      assert.equal(report.audio.captionWindowsCompared, 1);
      assert.equal(JSON.stringify(report).includes("data:image"), false, "Reports never retain the image request bodies");
      assert.equal(JSON.stringify(report).includes(directory), false);
      assert.deepEqual(await readFile(output), bytes, "Inspection does not rewrite the finished export");
      await reviewFinishedVideo({ ...input, cacheFile: path.join(directory, "audio-cache.json") }, { transcriber, vision: async samples => pass(samples) });
      assert.equal(transcriptions, 1, "Unchanged output reuses only its rendered-audio evidence");
    });
    await t.test("provider failure preserves completed audio checks and names the safe reason", async () => {
      const report = await reviewFinishedVideo(input, { transcriber: async () => speech(caption.text), vision: async () => { throw new AIRequestError("rate-limit"); } });
      assert.equal(report.status, "partial"); assert.match(report.picture.reason || "", /limited requests/u);
      assert.equal(report.checks.find(check => check.name === "caption-speech")?.status, "pass");
      assert.equal(report.checks.find(check => check.name === "text-layout")?.status, "unavailable");
    });
    await t.test("unknown sample IDs, missing inspections and unsupported accusations never pass as valid picture evidence", async () => {
      for (const kind of ["unknown", "not-inspected", "ungrounded"] as const) {
        const report = await reviewFinishedVideo(input, { transcriber: async () => speech(caption.text), vision: async samples => ({ samples: samples.map(sample => ({
          id: kind === "unknown" ? "invented-id" : sample.id, inspected: kind !== "not-inspected", caption: null,
          issues: kind === "ungrounded" ? [{ check: "demonstration-hidden", confidence: 0.99, message: "This is an invented demonstration.", evidence: "No replacement exists at this opening frame." }] : [],
        })) }) });
        assert.equal(report.status, "partial"); assert.equal(report.picture.frames, 0);
        assert.equal(report.issues.length, 0);
      }
    });
    await t.test("caller cancellation propagates instead of saving an unavailable review", async () => {
      const controller = new AbortController(); controller.abort();
      await assert.rejects(reviewFinishedVideo({ ...input, signal: controller.signal }), error => (error as Error).name === "AbortError");
    });
    await t.test("missing original pictures do not claim demonstration coverage", async () => {
      const report = await reviewFinishedVideo({ ...input, sourcePath: path.join(directory, "missing.mp4") }, {
        transcriber: async () => speech(caption.text), vision: async samples => pass(samples),
      });
      assert.equal(report.picture.sourceFrames, 0); assert.equal(report.status, "partial");
      assert.equal(report.checks.find(check => check.name === "demonstration-hidden")?.status, "unavailable");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
