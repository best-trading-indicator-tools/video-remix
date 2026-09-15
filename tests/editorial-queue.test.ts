import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type EditPlan, type Transcript } from "../shared/types.js";
import type { EditorialReviewRequest } from "../shared/editorial.js";
import type { EditorialRepairRequest } from "../shared/editorial-repair.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const spoken = "This method does not always work.";
const repairedHook = "This method does not always work";
const transcript = (): Transcript => ({ language: "en", duration: 8, segments: [
  { start: 0, end: 2, text: "Here is the important question.", words: [
    { start: 0, end: 0.4, word: "Here" }, { start: 0.4, end: 0.8, word: "is" }, { start: 0.8, end: 1.2, word: "the" },
    { start: 1.2, end: 1.6, word: "important" }, { start: 1.6, end: 2, word: "question." },
  ] },
  { start: 2, end: 6, text: spoken, words: [
    { start: 2, end: 2.5, word: "This" }, { start: 2.5, end: 3, word: "method" }, { start: 3, end: 3.5, word: "does" },
    { start: 3.5, end: 4, word: "not" }, { start: 4, end: 5, word: "always" }, { start: 5, end: 6, word: "work." },
  ] },
  { start: 6, end: 8, text: "Because conditions affect the result.", words: [
    { start: 6, end: 6.4, word: "Because" }, { start: 6.4, end: 6.8, word: "conditions" }, { start: 6.8, end: 7.2, word: "affect" },
    { start: 7.2, end: 7.6, word: "the" }, { start: 7.6, end: 8, word: "result." },
  ] },
] });

// Exercise the actual queue, DeepSeek request transport, state file, caption sidecar
// and FFmpeg export. The synthetic transcript is a fixture, not an ASR-quality
// claim. Every provider request is intercepted with a fake key; no network or
// speech model is used.
test("the queue renders only verified repairs, protects manual edits, and retains its retry budget", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-editorial-queue-"));
  let scenario: "repair" | "manual" | "rollback" = "repair";
  let reviews = 0, proposals = 0;
  const modelErrors: unknown[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    try {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions", "Only the fixed DeepSeek endpoint may be requested");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer editorial-queue-test-key");
      const envelope = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[]; model: string; response_format: { type: string } };
      assert.equal(envelope.model, "editorial-test-model");
      assert.equal(envelope.response_format.type, "json_object");
      assert.deepEqual(envelope.messages.map(message => message.role), ["system", "user"]);
      const prompt = JSON.parse(envelope.messages[1]!.content) as { input: EditorialReviewRequest | { input: EditorialRepairRequest }; outputSchema: unknown };
      assert.ok(prompt.outputSchema, "The provider must receive the required reply schema");
      const input = prompt.input;
      let result: unknown;
      if ("input" in input) {
        proposals++;
        const repair = input.input;
        const cite = (id: string) => {
          const row = repair.review.excerpts.find(item => item.sourceId === id)!;
          return { sourceId: row.sourceId, start: row.start, end: row.end, quote: row.quote };
        };
        result = scenario === "rollback" ? {
          targetCodes: ["hook-supported"], summary: "Restore source wording.",
          hook: { text: repairedHook, evidence: [cite("selected-0-1")] },
        } : repair.attempt === 1 ? {
          targetCodes: ["hook-supported", "captions-supported"], summary: "Restore the spoken qualification in headline and caption.",
          hook: { text: repairedHook, evidence: [cite("selected-0-1")] },
          captions: [{ id: "caption-1", text: spoken, evidence: [cite("selected-0-1")] }],
        } : {
          targetCodes: ["ending-complete"], summary: "Restore the explanation at the end.",
          extensions: [{ cutIndex: 0, end: 8, evidence: [cite("context-2")] }],
        };
      } else {
        reviews++;
        const bad = scenario === "rollback"
          ? input.hook === "Everyone succeeds" ? ["hook-supported"] : ["meaning-preserved"]
          : [...(input.hook === "Everyone succeeds" ? ["hook-supported"] : []),
            ...(input.captions[0]!.text === spoken ? [] : ["captions-supported"]),
            ...(input.outputDuration < 6 ? ["ending-complete"] : [])];
        result = { checks: Object.fromEntries(input.checks.map(check => {
          const selectedRows = input.excerpts.filter(row => row.role === "selected");
          const selected = check === "ending-complete" ? selectedRows.at(-1)! : selectedRows[0]!;
          const context = input.excerpts.find(row => row.sourceId === "context-2") || input.excerpts.find(row => row.role === "context")!;
          const issue = bad.includes(check);
          const comparison = {
            "opening-context": { openingWords: selected.quote, subjectOrQuestion: "The method's reliability", necessaryOmittedContext: null, relationship: "self-contained" },
            "ending-complete": { endingWords: selected.quote, pointBeingMade: "The method has conditions", unresolvedPromise: issue ? "Why the method sometimes fails" : null, relationship: issue ? "unfinished" : "resolved" },
            "hook-supported": { onScreenClaims: [input.hook, ...(input.callouts || []).map(item => item.text)].filter(Boolean), sourceClaim: selected.quote,
              onScreenScope: issue ? "Everyone" : "This method", sourceScope: "This method", onScreenCertainty: issue ? "absolute" : "conditional", sourceCertainty: "conditional", relationship: issue ? "broader-than-source" : "supported" },
            "meaning-preserved": { selectedClaim: selected.quote, originalClaim: issue ? context.quote : selected.quote,
              omittedOrChangedMeaning: issue ? context.quote : null, relationship: issue ? "lost-qualification" : "preserved" },
            "captions-supported": { captionWords: input.captions[0]!.text, spokenWords: selected.quote, difference: issue ? "The caption omits the spoken qualification" : null, relationship: issue ? "unsupported" : "faithful" },
          }[check];
          return [check, { verdict: issue ? "issue" : "pass", comparison,
            selectedEvidence: { sourceId: selected.sourceId, quote: selected.quote },
            additionalEvidence: check === "meaning-preserved" && issue ? [{ sourceId: context.sourceId, quote: context.quote }] : [] }];
        })) };
      }
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] });
    } catch (error) {
      modelErrors.push(error);
      return Response.json({ error: "Invalid isolated fixture request" }, { status: 500 });
    }
  };
  const savedEnvironment = { DATA_DIR: process.env.DATA_DIR, AUTO_AI: process.env.AUTO_AI,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_TEXT_MODEL: process.env.DEEPSEEK_TEXT_MODEL, RENDER_CONCURRENCY: process.env.RENDER_CONCURRENCY };
  Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "true",
    DEEPSEEK_API_KEY: "editorial-queue-test-key", DEEPSEEK_TEXT_MODEL: "editorial-test-model", RENDER_CONCURRENCY: "1" });
  const { paths } = await import("../server/config.js");
  const { initStore, saveStore, state, publicJob } = await import("../server/store.js");
  const { pumpQueue, stopQueue } = await import("../server/queue.js");
  const { renderVideo, probeMedia } = await import("../server/engine.js");
  const { captionCuesSrt } = await import("../server/edit-plan.js");
  try {
    await initStore();
    const sourcePath = path.join(paths.uploads, "source.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-threads", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath]);
    const source: StoredSource = { id: randomUUID(), name: "editorial-fixture.mp4", size: (await stat(sourcePath)).size,
      ...await probeMedia(sourcePath), createdAt: new Date().toISOString(), url: "", thumbnailUrl: "", filePath: sourcePath,
      thumbnailPath: path.join(paths.thumbnails, "unused.jpg") };
    state.sources.push(source);
    const makeJob = (manual = false): StoredJob => {
      const id = randomUUID();
      const plan: EditPlan = { version: 1, resolutionSizing: "exact", revision: manual ? 2 : 1, sourceId: source.id,
        sourceDuration: 8, outputDuration: 4, createdAt: new Date().toISOString(), narration: false,
        settings: { ...DEFAULT_SETTINGS, hookText: "Everyone succeeds", segments: [{ start: 2, end: 6 }] },
        cuts: [{ start: 2, end: 6 }], captions: [{ id: "caption-1", start: 0, end: 4, text: "This method always works." }], media: [], visuals: [] };
      return { id, sourceId: source.id, sourceName: source.name, batchId: randomUUID(), variant: 1,
        status: "queued", progress: 0, createdAt: plan.createdAt, outputPath: path.join(paths.outputs, `${id}.mp4`),
        settings: structuredClone(plan.settings), editPlan: plan, sourceTranscript: transcript(), planFiles: {},
        auto: { aspect: "16:9", targetDuration: 30, narration: false, editorialMode: "repair", supportingVisuals: "off" },
        summary: { title: "Everyone succeeds", changes: [], sourceDuration: 8, outputDuration: 4, transcriptAvailable: true, usedAI: false, narration: false },
        ...(manual ? { parentJobId: randomUUID(), corrections: { captionCorrections: 1, brollChanges: 0, seconds: 17 } } : {}) };
    };
    const completed = async (job: StoredJob) => {
      if (!state.jobs.includes(job)) state.jobs.push(job);
      await saveStore();
      pumpQueue();
      const deadline = Date.now() + 45000;
      while (["queued", "processing"].includes(job.status) && Date.now() < deadline) await sleep(30);
      assert.equal(job.status, "completed", `${job.error || job.phase}; model errors: ${modelErrors.map(String).join("; ")}`);
      assert.deepEqual(modelErrors, []);
      return job;
    };
    const frameDigest = async (file: string, time: number) => {
      const { stdout } = await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-ss", String(time),
        "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 * 1024 });
      return createHash("sha256").update(stdout).digest("hex");
    };
    let repaired!: StoredJob;
    await t.test("corrected cuts, hook and captions reach the actual export and durable history", async () => {
      repaired = await completed(makeJob());
      assert.equal(reviews, 3); assert.equal(proposals, 2);
      assert.equal(repaired.editorialReport!.status, "pass");
      assert.equal(repaired.editPlan!.revision, 1);
      assert.deepEqual(repaired.editPlan!.cuts, [{ start: 2, end: 8 }]);
      assert.equal(repaired.editPlan!.settings.hookText, repairedHook);
      assert.deepEqual(repaired.settings, repaired.editPlan!.settings);
      assert.equal(repaired.editPlan!.captions[0]!.text, spoken);
      assert.equal(repaired.summary!.outputDuration, 6); assert.equal(repaired.summary!.title, repairedHook);
      assert.equal(repaired.corrections, undefined, "Automatic work must not increment human-correction measurements");
      assert.deepEqual(repaired.editorialRepair!.attempts.map(item => item.outcome), ["accepted", "accepted"]);
      const srt = await readFile(repaired.captionPath!, "utf8");
      assert.match(srt, /does not always work/u); assert.match(srt, /Because conditions/u);
      assert.ok(Math.abs((await probeMedia(repaired.outputPath)).duration - 6) < 0.1);
      const expectedWork = path.join(directory, "expected");
      await mkdir(expectedWork);
      const expectedSrt = path.join(expectedWork, "expected.srt"), expectedOutput = path.join(expectedWork, "expected.mp4");
      await writeFile(expectedSrt, captionCuesSrt(repaired.editPlan!.captions));
      // A direct render from the asserted final plan catches stale queue inputs,
      // including a saved corrected hook/caption that never reached the MP4.
      await renderVideo({ input: sourcePath, output: expectedOutput, source, settings: repaired.editPlan!.settings,
        subtitlePath: expectedSrt, supportingVisuals: [], workDir: expectedWork, signal: new AbortController().signal, onProgress: () => {} });
      assert.equal(await frameDigest(repaired.outputPath, 1), await frameDigest(expectedOutput, 1), "Burned hook/caption and selected source frame must use the final plan");
      assert.equal(await frameDigest(repaired.outputPath, 5), await frameDigest(expectedOutput, 5), "Restored ending and its caption must be rendered");
      const stored = JSON.parse(await readFile(path.join(directory, "data", "state.json"), "utf8")) as { jobs: StoredJob[]; history: { jobId: string; editorialRepair?: unknown; editorialMode?: string }[] };
      assert.deepEqual(stored.jobs.find(job => job.id === repaired.id)!.editPlan, JSON.parse(JSON.stringify(repaired.editPlan)));
      assert.deepEqual(stored.history.find(entry => entry.jobId === repaired.id)!.editorialRepair, JSON.parse(JSON.stringify(repaired.editorialRepair)));
      assert.equal(stored.history.find(entry => entry.jobId === repaired.id)!.editorialMode, "repair");
      assert.ok(!JSON.stringify(publicJob(repaired)).includes(directory), "Public review/repair logs must not expose local paths");
    });
    await t.test("render retry rechecks the saved result without granting more proposals", async () => {
      assert.ok(repaired);
      const attempts = structuredClone(repaired.editorialRepair!.attempts), plan = structuredClone(repaired.editPlan);
      const priorProposals = proposals, priorReviews = reviews;
      repaired.status = "queued";
      await completed(repaired);
      assert.equal(proposals, priorProposals); assert.equal(reviews, priorReviews + 1);
      assert.deepEqual(repaired.editPlan, plan); assert.deepEqual(repaired.editorialRepair!.attempts, attempts);
      assert.match(repaired.editorialRepair!.stopReason, /No additional automatic corrections/u);
    });
    await t.test("a manual revision remains check-only and preserves human corrections", async () => {
      scenario = "manual";
      const manual = makeJob(true), plan = structuredClone(manual.editPlan), corrections = structuredClone(manual.corrections);
      const priorProposals = proposals, priorReviews = reviews;
      await completed(manual);
      assert.equal(proposals, priorProposals); assert.equal(reviews, priorReviews + 1);
      assert.deepEqual(manual.editPlan, plan); assert.deepEqual(manual.corrections, corrections);
      assert.equal(manual.editorialRepair!.attempts.length, 0); assert.equal(manual.editorialReport!.status, "needs-review");
      assert.equal(manual.phase, "Needs review");
      assert.match(await readFile(manual.captionPath!, "utf8"), /This method always works\./u);
      assert.ok(Math.abs((await probeMedia(manual.outputPath)).duration - 4) < 0.1);
    });
    await t.test("regressive proposals are logged but their text never reaches the final plan", async () => {
      scenario = "rollback";
      const rollback = makeJob(); rollback.editPlan!.captions[0]!.text = spoken;
      const plan = structuredClone(rollback.editPlan), priorProposals = proposals, priorReviews = reviews;
      await completed(rollback);
      assert.equal(proposals, priorProposals + 2); assert.equal(reviews, priorReviews + 3);
      assert.deepEqual(rollback.editPlan, plan); assert.equal(rollback.settings.hookText, "Everyone succeeds");
      assert.equal(rollback.editorialReport!.status, "needs-review"); assert.equal(rollback.phase, "Needs review");
      assert.ok(rollback.editorialRepair!.attempts.every(item => item.outcome === "rejected" && item.afterReport!.issues.some(issue => issue.code === "meaning-preserved")));
      assert.ok(Math.abs((await probeMedia(rollback.outputPath)).duration - 4) < 0.1);
    });
    await t.test("check-only and disabled modes preserve their behavior in the job and history", async () => {
      scenario = "manual";
      for (const mode of ["check", "off"] as const) {
        const job = makeJob(); job.auto!.editorialMode = mode;
        const plan = structuredClone(job.editPlan), priorProposals = proposals, priorReviews = reviews;
        await completed(job);
        assert.equal(proposals, priorProposals); assert.equal(reviews, priorReviews + (mode === "check" ? 1 : 0));
        assert.deepEqual(job.editPlan, plan); assert.equal(job.editorialModeApplied, mode);
        assert.equal(job.editorialRepair, undefined);
        assert.equal(job.editorialReport?.status, mode === "check" ? "needs-review" : undefined);
        const entry = state.history.find(item => item.jobId === job.id)!;
        assert.equal(entry.editorialMode, mode);
        assert.deepEqual(entry.editorialReport, job.editorialReport);
      }
    });
  } finally {
    await stopQueue();
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
