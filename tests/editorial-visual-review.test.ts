import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type EditPlan } from "../shared/types.js";
import { editorialFrameSamples, type VisualEditorialRequest, type VisualEditorialReviewer } from "../server/editorial-visual-review.js";
import { reviewEditorialPlan } from "../server/editorial-review.js";
import { repairEditorialPlan } from "../server/editorial-repair.js";
import { config } from "../server/config.js";
import { runLocal } from "../server/auto-process.js";

const edit = (): EditPlan => ({ version: 1, revision: 1, sourceId: "silent-video", sourceDuration: 8, outputDuration: 4,
  createdAt: "2026-10-03T00:00:00Z", cuts: [{ start: 1, end: 5 }], settings: { ...DEFAULT_SETTINGS, muted: true, hookText: "" },
  captions: [], visuals: [], media: [], narration: false });
const passing = (request: VisualEditorialRequest) => {
  const selected = request.frames.filter(frame => frame.role === "selected");
  const context = request.frames.find(frame => frame.role === "context");
  return { frames: request.frames.map(frame => ({ frameId: frame.id, readable: true })),
    checks: request.checks.map(check => ({ check, verdict: "pass", explanation: "The visible subject stays consistent in the sampled sequence.",
      evidence: [{ frameId: check === "ending-complete" ? selected.at(-1)!.id : selected[0]!.id, observation: "A visible test pattern fills the frame." },
        ...(check === "meaning-preserved" && context ? [{ frameId: context.id, observation: "The neighboring source frame shows the same pattern." }] : [])] })) };
};

test("visual sampling follows the edit's speed and reordered source cuts within a fixed image budget", () => {
  const plan = edit(); plan.cuts = [{ start: 5, end: 7 }, { start: 1, end: 3 }]; plan.settings.speed = 2; plan.outputDuration = 2;
  const frames = editorialFrameSamples(plan), selected = frames.filter(frame => frame.role === "selected");
  assert.deepEqual(selected.map(frame => frame.cutIndex), [0, 0, 0, 1, 1, 1]);
  assert.ok(selected[0]!.sourceAt > selected.at(-1)!.sourceAt);
  assert.ok(selected.every((frame, index) => !index || frame.outputAt! > selected[index - 1]!.outputAt!));
  assert.equal(selected[1]!.outputAt, 0.5); assert.equal(selected[4]!.outputAt, 1.5);
  assert.ok(frames.filter(frame => frame.role === "context").every(frame => frame.outputAt === undefined));
  plan.cuts = Array.from({ length: 60 }, (_, index) => ({ start: index / 10, end: index / 10 + 0.05 }));
  const bounded = editorialFrameSamples(plan);
  assert.ok(bounded.length <= 16);
  assert.equal(bounded.find(frame => frame.role === "selected")!.cutIndex, 0);
  assert.equal(bounded.filter(frame => frame.role === "selected").at(-1)!.cutIndex, 59);
});

test("transcript-free editorial review decodes real video frames and never invents speech coverage", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "editorial-visual-test-"));
  const sourcePath = path.join(directory, "silent.mp4");
  const enabled = config.aiEnabled, key = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_VISION_MODEL;
  config.aiEnabled = true; process.env.DEEPSEEK_API_KEY = "isolated-test-key"; process.env.DEEPSEEK_VISION_MODEL = "deepseek-flash";
  const run = (plan = edit(), visualReviewer: VisualEditorialReviewer = async request => passing(request), signal = new AbortController().signal) =>
    reviewEditorialPlan({ plan, sourcePath, visualReviewer, signal, reviewer: async () => assert.fail("Missing speech must use vision") });
  try {
    await runLocal("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=8",
      "-an", "-c:v", "libx264", "-threads", "1", sourcePath]);
    const originalBytes = await readFile(sourcePath);
    await t.test("a silent video gets a labeled visual review with source-frame observations", async () => {
      const plan = edit(), original = structuredClone(plan);
      const report = await run(plan, async request => {
        assert.ok(request.frames.every(frame => /^data:image\/jpeg;base64,/u.test(frame.image)));
        assert.deepEqual(request.checks, ["opening-context", "ending-complete", "meaning-preserved"]);
        assert.ok(request.frames.some(frame => frame.role === "context"));
        return passing(request);
      });
      assert.equal(report.status, "pass"); assert.equal(report.failure, undefined);
      assert.equal(report.coverage.source, "visual"); assert.equal(report.coverage.mode, "visual");
      assert.equal(report.coverage.sourceVisuals, true); assert.equal(report.coverage.renderedAudio, false);
      assert.equal(report.coverage.selectedWords, 0); assert.equal(report.coverage.semantic, "complete");
      assert.equal(report.coverage.visual?.sampledFrames, 5); assert.equal(report.coverage.visual?.sampledCuts, 1);
      assert.ok(report.coverage.omittedChecks.includes("selected-speech-fidelity"));
      assert.equal(report.checks.find(check => check.check === "cut-boundaries")?.status, "unavailable");
      assert.equal(report.issues.length, 0, "A muted video without speech must not receive a muted-speech warning");
      assert.equal(JSON.stringify(report).includes("data:image"), false); assert.equal(JSON.stringify(report).includes(directory), false);
      assert.deepEqual(plan, original); assert.deepEqual(await readFile(sourcePath), originalBytes);
    });
    await t.test("an empty transcript and a transcript outside the selected cuts both use vision", async () => {
      for (const segments of [[], [{ start: 6, end: 7, text: "Outside this edit", words: [] }]]) {
        const report = await reviewEditorialPlan({ plan: edit(), sourcePath, transcript: { language: "en", duration: 8, segments },
          visualReviewer: async request => passing(request), signal: new AbortController().signal });
        assert.equal(report.coverage.source, "visual"); assert.equal(report.status, "pass");
      }
    });
    await t.test("visual findings retain source observations and actual output seek times without speech repair", async () => {
      const plan = edit(); plan.settings.hookText = "A completed demonstration";
      const original = structuredClone(plan);
      const result = await repairEditorialPlan({ plan, sourcePath, signal: new AbortController().signal, maxDuration: 8,
        visualReviewer: async request => {
          assert.ok(request.checks.includes("hook-supported"));
          const reply = passing(request), ending = reply.checks.find(check => check.check === "ending-complete")!;
          ending.verdict = "issue"; ending.explanation = "The sampled ending does not show the promised completed demonstration.";
          return reply;
        }, proposer: async () => assert.fail("Visual observations cannot be used as quoted speech for a repair") });
      assert.equal(result.report.status, "needs-review"); assert.deepEqual(result.plan, original);
      assert.deepEqual(result.repairLog.attempts, []); assert.match(result.repairLog.stopReason, /Visual editorial review/);
      const issue = result.report.issues.find(issue => issue.check === "ending-complete")!;
      assert.equal(issue.evidence[0]!.kind, "visual"); assert.ok(issue.evidence[0]!.start > 4.8);
      assert.ok(issue.outputStart! > 3.8 && issue.outputStart! < 4);
    });
    await t.test("unreadable frames, unsampled cuts, and speech captions keep coverage partial", async () => {
      const unreadable = await run(edit(), async request => {
        const reply = passing(request); reply.frames.forEach(frame => { frame.readable = false; });
        reply.checks.forEach(check => { check.verdict = "uncertain"; }); return reply;
      });
      assert.equal(unreadable.status, "needs-review"); assert.equal(unreadable.coverage.semantic, "partial");
      assert.equal(unreadable.coverage.sourceVisuals, false);
      const manyCuts = edit(); manyCuts.cuts = Array.from({ length: 6 }, (_, index) => ({ start: index, end: index + 0.5 })); manyCuts.outputDuration = 3;
      const partial = await run(manyCuts);
      assert.equal(partial.status, "needs-review"); assert.equal(partial.coverage.visual?.sampledCuts, 4);
      assert.equal(partial.coverage.visual?.totalCuts, 6); assert.ok(partial.coverage.omittedChecks.includes("full-visual-sequence"));
      const captions = edit(); captions.captions = [{ id: "speech", start: 0, end: 1, text: "Unverified spoken words" }];
      const captionReport = await run(captions);
      assert.equal(captionReport.status, "needs-review");
      assert.equal(captionReport.checks.find(check => check.check === "captions-supported")?.status, "unavailable");
    });
    await t.test("invented frames, missing checks, wrong anchors and unreadable passing evidence cannot be accepted", async () => {
      const mutations: ((reply: ReturnType<typeof passing>) => void)[] = [
        reply => { reply.checks[0]!.evidence[0]!.frameId = "invented"; },
        reply => { reply.frames.pop(); },
        reply => { reply.checks.pop(); },
        reply => { reply.checks[0]!.evidence[0]!.frameId = "selected-0-2"; },
        reply => { reply.frames[0]!.readable = false; },
        reply => { reply.checks.find(check => check.check === "meaning-preserved")!.evidence.pop(); },
      ];
      for (const mutate of mutations) {
        const report = await run(edit(), async request => { const reply = passing(request); mutate(reply); return reply; });
        assert.equal(report.status, "unavailable"); assert.equal(report.coverage.semantic, "unavailable");
        assert.ok(!report.checks.some(check => check.origin === "semantic" && check.status === "pass"));
      }
    });
    await t.test("provider serialization uses Flash image input and validates its reply inside retries", async () => {
      const fetcher = globalThis.fetch; let calls = 0;
      try {
        globalThis.fetch = async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init!.body)); assert.equal(body.model, "deepseek-flash");
          const content = body.messages.find((message: { role: string }) => message.role === "user").content;
          const request = JSON.parse(content[0].text).input as VisualEditorialRequest;
          assert.equal(content.filter((part: { type: string }) => part.type === "image_url").length, request.frames.length);
          assert.equal(JSON.stringify(body).includes(sourcePath), false);
          const reply = passing(request);
          if (calls === 1) reply.checks[0]!.evidence[0]!.frameId = "invented";
          return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] });
        };
        const report = await reviewEditorialPlan({ plan: edit(), sourcePath, signal: new AbortController().signal });
        assert.equal(report.status, "pass"); assert.equal(calls, 2); assert.equal(report.modelVersion, "deepseek-flash");
      } finally { globalThis.fetch = fetcher; }
    });
    await t.test("changed source files and cancellation discard a prospective visual pass", async () => {
      const original = await stat(sourcePath);
      try {
        const changed = await run(edit(), async request => { await utimes(sourcePath, original.atime, new Date(original.mtimeMs + 1000)); return passing(request); });
        assert.equal(changed.status, "unavailable"); assert.equal(changed.failure?.code, "source-changed");
      } finally { await utimes(sourcePath, original.atime, original.mtime); }
      const controller = new AbortController();
      await assert.rejects(run(edit(), async () => { controller.abort(); return new Promise(() => undefined); }, controller.signal),
        error => (error as Error).name === "AbortError");
    });
    await t.test("disabled AI, missing credentials, or missing media do not call the visual provider", async () => {
      const never: VisualEditorialReviewer = async () => assert.fail("No provider call is allowed");
      const disabled = await reviewEditorialPlan({ plan: edit(), sourcePath, aiEnabled: false, visualReviewer: never, signal: new AbortController().signal });
      assert.equal(disabled.failure?.code, "disabled");
      delete process.env.DEEPSEEK_API_KEY;
      const missingKey = await run(edit(), never); assert.equal(missingKey.failure?.code, "configuration");
      process.env.DEEPSEEK_API_KEY = "isolated-test-key";
      const missing = await reviewEditorialPlan({ plan: edit(), sourcePath: path.join(directory, "missing.mp4"), visualReviewer: never, signal: new AbortController().signal });
      assert.equal(missing.status, "unavailable"); assert.equal(missing.modelVersion, null);
    });
  } finally {
    config.aiEnabled = enabled;
    if (key === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = key;
    if (model === undefined) delete process.env.DEEPSEEK_VISION_MODEL; else process.env.DEEPSEEK_VISION_MODEL = model;
    await rm(directory, { recursive: true, force: true });
  }
});
