import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchCompletionTracker, batchEstimate, jobEstimate, observeWork, observePhase, stageEstimate, timingProfile, timeRange, type ProcessingTiming } from "../shared/processing-time.js";
import { DEFAULT_SETTINGS, DEFAULT_AUTO_OPTIONS, type RenderJob } from "../shared/types.js";
const source = { width: 640, height: 360, fps: 30, duration: 60 };
const timing = (): ProcessingTiming => ({ profile: "computer-a", startedAt: 1_000, sourceSeconds: 60, outputSeconds: 60 });
const job = (id: string, patch: Partial<RenderJob> = {}): RenderJob => ({ id, sourceId: "source", sourceName: "clip", variant: 1, batchId: "batch", status: "queued", progress: 0, settings: { ...DEFAULT_SETTINGS }, createdAt: new Date(0).toISOString(), timing: timing(), ...patch });
test("raw work speed yields a range, never guesses from a weighted percentage", () => {
  const t = timing(); observeWork(t, "upscale", 10, 0); assert.equal(stageEstimate(t, 0), undefined);
  observeWork(t, "upscale", 20, 10_000); assert.deepEqual(stageEstimate(t, 10_000), { low: 64, high: 112, basis: "speed" });
  assert.equal(stageEstimate(t, 31_000), undefined); // stalled worker
  observeWork(t, "upscale", 5, 32_000); assert.equal(stageEstimate(t, 32_000), undefined); // restarted on CPU
  observeWork(t, "render", 0, 40_000); assert.equal(stageEstimate(t, 40_000), undefined);
  assert.equal(jobEstimate(job("active", { status: "processing", progress: 90 }), [], 40_000), undefined);
});
test("learns from comparable successful local jobs and rejects failures, retries and different hardware/settings", () => {
  const past = job("done", { status: "completed", timing: { ...timing(), elapsedMs: 120_000 } });
  const current = job("active", { status: "processing" });
  assert.deepEqual(jobEstimate(current, [past], 31_000), { low: 48, high: 162, basis: "history" });
  for (const bad of [{ status: "failed" }, { timing: { ...past.timing!, profile: "another-pc" } }, { retry: { count: 1 } }, { timing: { ...past.timing!, outputSeconds: 1000 } }])
    assert.equal(jobEstimate(current, [{ ...past, ...bad } as RenderJob], 31_000), undefined);
  assert.equal(jobEstimate(current, [past], 250_000), undefined);
});
test("batch time includes queued work, concurrency bounds and retry delay; unknown work suppresses total", () => {
  const past = job("done", { status: "completed", timing: { ...timing(), elapsedMs: 120_000 } });
  const batch = [job("one", { status: "processing" }), job("two")];
  const estimate = batchEstimate(batch, [past, ...batch], 2, 31_000)!;
  assert.equal(estimate.low, 78); assert.equal(estimate.high, 354); assert.equal(timeRange(estimate), "1–6 minutes");
  assert.equal(batchEstimate([batch[0], job("unknown", { timing: undefined })], [past], 2, 31_000), undefined);
  assert.equal(batchEstimate(batch, [past, ...batch, job("other", { batchId: "other" })], 2), undefined);
});
test("profiles distinguish expensive options and full-length Auto jobs", () => {
  const normal = timingProfile(job("a"), source, "pc");
  const upscale = timingProfile(job("b", { settings: { ...DEFAULT_SETTINGS, upscale: "1080" } }), source, "pc");
  assert.notEqual(normal.profile, upscale.profile);
  assert.equal(timingProfile(job("auto", { auto: { ...DEFAULT_AUTO_OPTIONS, durationMode: "full", targetDuration: 10 } }), source, "pc").outputSeconds, 60);
});
test("long batches notify once with honest mixed outcomes, ignore old history, and notify again after a retry", () => {
  const tracker = new BatchCompletionTracker();
  assert.deepEqual(tracker.observe([job("old", { status: "completed" })], 100_000), []);
  const active = [job("a", { status: "processing" }), job("b")]; tracker.observe(active, 10_000);
  const finished = [job("a", { status: "completed" }), job("b", { status: "failed" })];
  assert.deepEqual(tracker.observe(finished, 70_000), [{ id: "batch", body: "1 ready · 1 failed" }]);
  assert.deepEqual(tracker.observe(finished, 80_000), []);
  tracker.observe([finished[0], job("b", { status: "processing", timing: { ...timing(), startedAt: 90_000 } })], 90_000);
  assert.equal(tracker.observe(finished, 160_000).length, 1);
  const short = new BatchCompletionTracker(); short.observe([job("a", { timing: undefined })], 1_000); assert.deepEqual(short.observe([job("a", { status: "completed" })], 2_000), []);
});

test("repeated GPU status preserves the live estimate, while a CPU fallback resets it", () => {
  const t = timing();
  observeWork(t, "upscale", 10, 0); observePhase(t, "Upscaling with local AI · Apple GPU");
  observeWork(t, "upscale", 20, 10_000); observePhase(t, "Upscaling with local AI · Apple GPU");
  assert.ok(stageEstimate(t, 10_000));
  observePhase(t, "Upscaling with local AI · CPU (slower)"); assert.equal(stageEstimate(t, 10_000), undefined);
});

test("waiting for the serialized GPU neither counts as processing speed nor consumes another job's estimate", () => {
  const t = timing(); observePhase(t, "Waiting for the local AI upscaler", 1_000);
  const past = job("past", { status: "completed", timing: { ...timing(), elapsedMs: 60_000 } });
  const current = job("current", { status: "processing", timing: t });
  assert.equal(jobEstimate(current, [past], 31_000)?.high, 96);
  observeWork(t, "upscale", 0, 31_000); assert.equal(t.waitingMs, 30_000); assert.equal(t.waitingAt, undefined);
  assert.equal(jobEstimate(current, [past], 41_000)?.high, 86);
});
