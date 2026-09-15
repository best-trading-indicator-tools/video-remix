import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type EditPlan, type Transcript } from "../shared/types.js";
import type { EditorialReviewer, EditorialReviewRequest } from "../shared/editorial.js";
import type { EditorialRepairProposer, EditorialRepairRequest } from "../shared/editorial-repair.js";
import { repairEditorialPlan } from "../server/editorial-repair.js";
import { applyEditPlanChanges } from "../server/edit-plan.js";
import { config } from "../server/config.js";

const source = (): Transcript => ({ language: "en", duration: 8, segments: [
  { start: 0, end: 2, text: "Here is the important question.", words: [
    { start: 0, end: 0.4, word: "Here" }, { start: 0.4, end: 0.8, word: "is" }, { start: 0.8, end: 1.2, word: "the" },
    { start: 1.2, end: 1.6, word: "important" }, { start: 1.6, end: 2, word: "question." },
  ] },
  { start: 2, end: 6, text: "This method does not always work.", words: [
    { start: 2, end: 2.5, word: "This" }, { start: 2.5, end: 3, word: "method" }, { start: 3, end: 3.5, word: "does" },
    { start: 3.5, end: 4, word: "not" }, { start: 4, end: 5, word: "always" }, { start: 5, end: 6, word: "work." },
  ] },
  { start: 6, end: 8, text: "Because conditions affect the result.", words: [
    { start: 6, end: 6.4, word: "Because" }, { start: 6.4, end: 6.8, word: "conditions" }, { start: 6.8, end: 7.2, word: "affect" },
    { start: 7.2, end: 7.6, word: "the" }, { start: 7.6, end: 8, word: "result." },
  ] },
] });
const edit = (): EditPlan => ({ version: 1, revision: 7, sourceId: "source", sourceDuration: 8, outputDuration: 4,
  createdAt: "2026-09-15T00:00:00Z", settings: { ...DEFAULT_SETTINGS, hookText: "Everyone succeeds", segments: [{ start: 2, end: 6 }] },
  cuts: [{ start: 2, end: 6 }], captions: [{ id: "caption-1", start: 0, end: 4, text: "This method does not always work." }],
  visuals: [], media: [], narration: false });
const quote = (request: EditorialRepairRequest, id = "selected-0-1") => {
  const row = request.review.excerpts.find(item => item.sourceId === id)!;
  return { sourceId: row.sourceId, start: row.start, end: row.end, quote: row.quote };
};
const verdicts = (request: EditorialReviewRequest, bad: string[] = []) => {
  const selected = request.excerpts.find(row => row.role === "selected")!;
  return { checks: request.checks.map(check => ({ check, verdict: bad.includes(check) ? "issue" : "pass",
    explanation: bad.includes(check) ? `Source evidence establishes a ${check} problem.` : "Source evidence supports this check.",
    evidence: [{ sourceId: selected.sourceId, start: selected.start, end: selected.end, quote: selected.quote }] })) };
};
const hookReview: EditorialReviewer = async request => verdicts(request, request.hook === "Everyone succeeds" ? ["hook-supported"] : []);
const fixHook: EditorialRepairProposer = async request => ({ targetCodes: ["hook-supported"], summary: "Restore a source-supported headline.",
  hook: { text: "This method does not always work", evidence: [quote(request)] } });
const run = (overrides: Partial<Parameters<typeof repairEditorialPlan>[0]> = {}) => repairEditorialPlan({
  plan: edit(), transcript: source(), signal: new AbortController().signal, maxDuration: 8, reviewer: hookReview, proposer: fixHook, ...overrides,
});

test("bounded editorial repair accepts independently verified improvements and preserves the best previous edit", async t => {
  const configured = config.aiEnabled;
  const savedEnvironment = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_TEXT_MODEL: process.env.DEEPSEEK_TEXT_MODEL };
  config.aiEnabled = true;
  Object.assign(process.env, { DEEPSEEK_API_KEY: "editorial-repair-test-key", DEEPSEEK_TEXT_MODEL: "editorial-test-model" });
  try {
    await t.test("source-grounded hook correction stays immutable and does not create a user revision", async () => {
      const plan = edit(), original = structuredClone(plan), transcript = source(), originalTranscript = structuredClone(transcript);
      const result = await run({ plan, transcript });
      assert.equal(result.plan.settings.hookText, "This method does not always work");
      assert.equal(result.plan.revision, 7); assert.equal(result.report.status, "pass");
      assert.deepEqual(plan, original); assert.deepEqual(transcript, originalTranscript);
      assert.equal(result.repairLog.attempts.length, 1);
      assert.equal(result.repairLog.attempts[0]!.outcome, "accepted");
      assert.equal(result.repairLog.initialReport.status, "needs-review");
      assert.equal(result.repairLog.finalReport.status, "pass");
      assert.equal(result.repairLog.attempts[0]!.patch!.revision, 7);
    });
    await t.test("at most two proposals and three independent reviews resolve successive issues", async () => {
      let proposals = 0, reviews = 0;
      const result = await run({ reviewer: async request => {
        reviews++;
        return verdicts(request, [...(request.hook === "Everyone succeeds" ? ["hook-supported"] : []),
          ...(request.outputDuration < 6 ? ["ending-complete"] : [])]);
      }, proposer: async request => {
        proposals++;
        if (request.attempt === 1) return fixHook(request, new AbortController().signal);
        return { targetCodes: ["ending-complete"], summary: "Restore the original explanation.",
          extensions: [{ cutIndex: 0, end: 8, evidence: [quote(request, "context-2")] }] };
      } });
      assert.equal(proposals, 2); assert.equal(reviews, 3);
      assert.equal(result.report.status, "pass"); assert.equal(result.plan.outputDuration, 6);
      assert.deepEqual(result.plan.cuts, [{ start: 2, end: 8 }]); assert.equal(result.plan.revision, 7);
      assert.ok(result.plan.captions.some(caption => caption.text.includes("Because")), "Existing retiming fills newly included source speech");
      assert.ok(result.repairLog.attempts.every(attempt => attempt.outcome === "accepted"));
    });
    await t.test("accepted boundary repairs preserve Auto caption omission and explicit caption removal", async () => {
      const auto = edit(); auto.captions = []; auto.captionMode = "off";
      const removed = applyEditPlanChanges(edit(), { revision: 7, captions: [] }, source());
      for (const plan of [auto, removed]) {
        plan.settings.hookText = "";
        const original = structuredClone(plan);
        let reviews = 0;
        const result = await run({ plan,
          reviewer: async request => {
            reviews++;
            assert.deepEqual(request.captions, [], "Repair verification must not silently regain generated captions");
            return verdicts(request, request.outputDuration < 6 ? ["ending-complete"] : []);
          },
          proposer: async request => ({ targetCodes: ["ending-complete"], summary: "Keep the complete explanation.",
            extensions: [{ cutIndex: 0, end: 8, evidence: [quote(request, "context-2")] }],
          }),
        });
        assert.equal(reviews, 2, "The boundary repair must reach independent verification");
        assert.equal(result.repairLog.attempts[0]!.outcome, "accepted");
        assert.equal(result.report.status, "pass");
        assert.deepEqual(result.plan.cuts, [{ start: 2, end: 8 }]);
        assert.equal(result.plan.outputDuration, 6);
        assert.deepEqual(result.plan.captions, []);
        assert.equal(result.plan.captionMode, "off");
        assert.equal(result.plan.revision, plan.revision);
        assert.deepEqual(plan, original);
      }
    });
    await t.test("a boundary repair cannot introduce an omitted hook even when its wording is source-supported", async () => {
      const plan = edit(); plan.settings.hookText = ""; plan.captions = []; plan.captionMode = "off";
      const original = structuredClone(plan);
      let reviews = 0;
      const result = await run({ plan,
        reviewer: async request => {
          reviews++;
          return verdicts(request, request.outputDuration < 6 ? ["ending-complete"] : []);
        },
        proposer: async request => ({ targetCodes: ["ending-complete"], summary: "Extend the explanation and add its heading.",
          extensions: [{ cutIndex: 0, end: 8, evidence: [quote(request, "context-2")] }],
          hook: { text: "This method does not always work", evidence: [quote(request)] },
        }),
      });
      assert.equal(reviews, 1, "The omitted-heading guard must reject the patch before semantic verification");
      assert.deepEqual(result.plan, original);
      assert.deepEqual(plan, original);
      assert.equal(result.report.status, "needs-review");
      assert.equal(result.repairLog.attempts.length, 2);
      assert.ok(result.repairLog.attempts.every(attempt => attempt.outcome === "rejected"));
    });
    await t.test("a new meaning error rolls back the proposed hook even when the targeted issue disappears", async () => {
      let reviews = 0, proposals = 0;
      const original = edit();
      const result = await run({ plan: original,
        reviewer: async request => { reviews++; return verdicts(request, request.hook === "Everyone succeeds" ? ["hook-supported"] : ["meaning-preserved"]); },
        proposer: async (request, signal) => { proposals++; return fixHook(request, signal); },
      });
      assert.equal(proposals, 2); assert.equal(reviews, 3);
      assert.deepEqual(result.plan, original);
      assert.equal(result.report.issues[0]!.code, "hook-supported");
      assert.ok(result.repairLog.attempts.every(attempt => attempt.outcome === "rejected"));
      assert.ok(result.repairLog.attempts.every(attempt => attempt.afterReport!.issues.some(issue => issue.code === "meaning-preserved")));
    });
    await t.test("a rejected second attempt retains an accepted first repair", async () => {
      const result = await run({ reviewer: async request => verdicts(request,
        [...(request.hook === "Everyone succeeds" ? ["hook-supported"] : []), ...(request.outputDuration === 4 ? ["ending-complete"] : ["meaning-preserved"])]),
      proposer: async request => request.attempt === 1 ? fixHook(request, new AbortController().signal)
        : ({ targetCodes: ["ending-complete"], summary: "Extend explanation.", extensions: [{ cutIndex: 0, end: 8, evidence: [quote(request, "context-2")] }] }),
      });
      assert.equal(result.plan.settings.hookText, "This method does not always work");
      assert.equal(result.plan.outputDuration, 4); assert.equal(result.report.status, "needs-review");
      assert.deepEqual(result.repairLog.attempts.map(item => item.outcome), ["accepted", "rejected"]);
    });
    await t.test("missing verification checks reject a patch and stop further repair", async () => {
      let reviews = 0, proposals = 0;
      const result = await run({ reviewer: async request => {
        reviews++; const reply = verdicts(request, ["hook-supported"]);
        if (reviews > 1) reply.checks.pop(); return reply;
      }, proposer: async (request, signal) => { proposals++; return fixHook(request, signal); } });
      assert.equal(proposals, 1); assert.equal(reviews, 2);
      assert.deepEqual(result.plan, edit());
      assert.equal(result.repairLog.attempts[0]!.afterReport!.coverage.semantic, "unavailable");
    });
    await t.test("unknown operations, fabricated evidence, outside-duration and non-source boundaries never reach review", async () => {
      const invalid: EditorialRepairProposer[] = [
        async request => ({ ...await fixHook(request, new AbortController().signal) as object, framing: { fit: "crop" } }),
        async () => ({ targetCodes: ["hook-supported"], summary: "Invented evidence.", hook: { text: "Everyone succeeds", evidence: [{ sourceId: "context-999", start: 2, end: 6, quote: "Everyone succeeds" }] } }),
        async request => ({ targetCodes: ["hook-supported"], summary: "A new unsupported claim.", hook: { text: "This method cures all diseases", evidence: [quote(request)] } }),
        async request => ({ targetCodes: ["hook-supported"], summary: "Boundary outside transcript.", extensions: [{ cutIndex: 0, end: 6.123, evidence: [quote(request, "context-2")] }] }),
        async request => ({ targetCodes: ["hook-supported"], summary: "Duration too long.", extensions: [{ cutIndex: 0, end: 8, evidence: [quote(request, "context-2")] }] }),
        async request => ({ targetCodes: ["hook-supported"], summary: "Delete selected speech.", extensions: [{ cutIndex: 0, start: 3, evidence: [quote(request)] }] }),
      ];
      for (const proposer of invalid) {
        let reviews = 0;
        const result = await run({ maxDuration: 4, proposer, reviewer: async request => { reviews++; return hookReview(request, new AbortController().signal); } });
        assert.equal(reviews, 1); assert.deepEqual(result.plan, edit());
        assert.equal(result.repairLog.attempts.length, 2); assert.ok(result.repairLog.attempts.every(attempt => attempt.outcome === "rejected"));
      }
    });
    await t.test("boundary extension cannot move B-roll or exceed modest neighboring context", async () => {
      const withVisual = edit(); withVisual.media = [{ id: "clip", name: "Original stock", kind: "broll", duration: 2 }];
      withVisual.visuals = [{ id: "shot", mediaId: "clip", start: 1, end: 2, sourceStart: 0, enabled: true, locked: true }];
      const result = await run({ plan: withVisual, proposer: async request => ({ targetCodes: ["hook-supported"], summary: "Restore earlier context.",
        extensions: [{ cutIndex: 0, start: 0, evidence: [quote(request, "context-0")] }] }) });
      assert.deepEqual(result.plan, withVisual);
      assert.ok(result.repairLog.attempts.every(attempt => attempt.outcome === "rejected"));
      const longerSource = source();
      longerSource.duration = 20;
      longerSource.segments[0] = { start: 0, end: 14, text: "Long earlier context.", words: [
        { start: 0, end: 1, word: "Long" }, { start: 1, end: 2, word: "earlier" }, { start: 13, end: 14, word: "context." },
      ] };
      longerSource.segments[1]!.start = 14; longerSource.segments[1]!.end = 18;
      longerSource.segments[1]!.words = longerSource.segments[1]!.words.map(word => ({ ...word, start: word.start + 12, end: word.end + 12 }));
      longerSource.segments[2]!.start = 18; longerSource.segments[2]!.end = 20;
      longerSource.segments[2]!.words = longerSource.segments[2]!.words.map(word => ({ ...word, start: word.start + 12, end: word.end + 12 }));
      const longerPlan = edit(); longerPlan.sourceDuration = 20; longerPlan.cuts = [{ start: 14, end: 18 }];
      const distant = await run({ plan: longerPlan, transcript: longerSource, maxDuration: 20, proposer: async request => ({
        targetCodes: ["hook-supported"], summary: "Restore distant context.", extensions: [{ cutIndex: 0, start: 0, evidence: [quote(request, "context-0")] }],
      }) });
      assert.deepEqual(distant.plan, longerPlan);
      assert.ok(distant.repairLog.attempts.every(attempt => attempt.outcome === "rejected"));
    });
    await t.test("caption fixes use the existing cue clock and cannot borrow words from another passage", async () => {
      const plan = edit(); plan.settings.hookText = "This method does not always work"; plan.captions[0]!.text = "This method always works.";
      const reviewer: EditorialReviewer = async request => verdicts(request,
        request.captions[0]!.text === "This method does not always work." ? [] : ["captions-supported"]);
      const result = await run({ plan, reviewer, proposer: async request => ({ targetCodes: ["captions-supported"], summary: "Restore the spoken negation.",
        captions: [{ id: "caption-1", text: "This method does not always work.", evidence: [quote(request)] }] }) });
      assert.equal(result.report.status, "pass"); assert.equal(result.plan.captions[0]!.start, 0); assert.equal(result.plan.captions[0]!.end, 4);
      const wrong = await run({ plan, reviewer, proposer: async request => ({ targetCodes: ["captions-supported"], summary: "Borrow other source speech.",
        captions: [{ id: "caption-1", text: "Because conditions affect the result.", evidence: [quote(request, "context-2")] }] }) });
      assert.deepEqual(wrong.plan, plan); assert.equal(wrong.report.status, "needs-review");
      let truncatedReviews = 0;
      const truncated = await run({ plan, reviewer: async request => {
        truncatedReviews++;
        return verdicts(request, truncatedReviews === 1 ? ["captions-supported"] : []);
      }, proposer: async request => ({ targetCodes: ["captions-supported"], summary: "Use a shorter source phrase.",
        captions: [{ id: "caption-1", text: "always work", evidence: [quote(request)] }] }) });
      assert.equal(truncatedReviews, 1, "A source substring that drops a qualifier must fail before semantic verification");
      assert.deepEqual(truncated.plan, plan);
      const signedSource = source();
      signedSource.segments[1]!.words[0]!.word = "−5%";
      signedSource.segments[1]!.text = "−5% method does not always work.";
      let signedReviews = 0;
      const signed = await run({ plan, transcript: signedSource, reviewer: async request => {
        signedReviews++;
        return verdicts(request, signedReviews === 1 ? ["captions-supported"] : []);
      }, proposer: async request => ({ targetCodes: ["captions-supported"], summary: "Restore numeric text.",
        captions: [{ id: "caption-1", text: "5 method does not always work.", evidence: [quote(request)] }] }) });
      assert.equal(signedReviews, 1, "Numeric signs and units must survive a source-supported caption correction");
      assert.deepEqual(signed.plan, plan);
    });
    await t.test("legacy neighboring context without word arrays does not prevent grounded repairs", async () => {
      const legacy = source();
      delete (legacy.segments[0] as Partial<Transcript["segments"][number]>).words;
      delete (legacy.segments[2] as Partial<Transcript["segments"][number]>).words;
      const originalTranscript = structuredClone(legacy);
      const hook = await run({ transcript: legacy });
      assert.equal(hook.report.status, "pass");
      assert.equal(hook.plan.settings.hookText, "This method does not always work");
      assert.equal(hook.repairLog.attempts[0]!.outcome, "accepted");
      const plan = edit(); plan.settings.hookText = "This method does not always work"; plan.captions[0]!.text = "This method always works.";
      const caption = await run({ plan, transcript: legacy,
        reviewer: async request => verdicts(request, request.captions[0]!.text === "This method does not always work." ? [] : ["captions-supported"]),
        proposer: async request => ({ targetCodes: ["captions-supported"], summary: "Restore the selected spoken words.",
          captions: [{ id: "caption-1", text: "This method does not always work.", evidence: [quote(request)] }] }),
      });
      assert.equal(caption.report.status, "pass");
      assert.equal(caption.plan.captions[0]!.text, "This method does not always work.");
      const extension = await run({ transcript: legacy, proposer: async request => ({ targetCodes: ["hook-supported"],
        summary: "Include untimed neighboring speech.", extensions: [{ cutIndex: 0, end: 8, evidence: [quote(request, "context-2")] }] }) });
      assert.deepEqual(extension.plan, edit(), "Untimed neighboring context must not become unverified selected speech");
      assert.equal(extension.report.status, "needs-review");
      assert.ok(extension.repairLog.attempts.every(attempt => attempt.outcome === "rejected"));
      assert.deepEqual(legacy, originalTranscript, "Legacy source evidence remains immutable");
    });
    await t.test("pinned manual edits, narration, replacement audio and uncertain findings are check-only", async () => {
      let proposals = 0;
      const proposer: EditorialRepairProposer = async () => { proposals++; throw new Error("Must not propose"); };
      for (const overrides of [{ protectedEdit: true }, { plan: { ...edit(), narration: true } }, { plan: { ...edit(), audioMediaId: "voice" } }]) {
        const result = await run({ ...overrides, proposer });
        assert.deepEqual(result.plan, overrides.plan || edit()); assert.equal(result.repairLog.attempts.length, 0);
      }
      const uncertain = await run({ proposer, reviewer: async request => {
        const reply = verdicts(request); reply.checks[0]!.verdict = "uncertain"; return reply;
      } });
      assert.equal(uncertain.repairLog.attempts.length, 0); assert.equal(proposals, 0);
    });
    await t.test("missing transcript, unavailable review and context beyond the cap do not start repairs", async () => {
      let proposals = 0;
      const proposer: EditorialRepairProposer = async () => { proposals++; throw new Error("Must not propose"); };
      assert.equal((await run({ transcript: undefined, proposer })).repairLog.attempts.length, 0);
      assert.equal((await run({ reviewer: async () => { throw new Error("Model unavailable"); }, proposer })).repairLog.attempts.length, 0);
      const enormous = source(); enormous.segments[0]!.words = []; enormous.segments[0]!.text = "context ".repeat(2000);
      const capped = await run({ transcript: enormous, proposer });
      assert.equal(capped.report.coverage.semantic, "partial"); assert.equal(capped.repairLog.attempts.length, 0);
      const manyCuts = edit();
      manyCuts.cuts = Array.from({ length: 60 }, () => ({ start: 2, end: 6 }));
      manyCuts.settings.segments = structuredClone(manyCuts.cuts); manyCuts.outputDuration = 240;
      const bounded = await run({ plan: manyCuts, maxDuration: 240, proposer });
      assert.equal(bounded.report.coverage.semantic, "complete", "The review can fit while the larger boundary-choice proposal context cannot");
      assert.equal(bounded.repairLog.attempts.length, 0); assert.match(bounded.repairLog.stopReason, /bounded model context/u);
      assert.equal(proposals, 0);
    });
    await t.test("DeepSeek proposal failure and overall timeout retain the reviewed plan without retry storms", async () => {
      const failure = await run({ proposer: async () => { throw new DOMException("private server path", "TimeoutError"); } });
      assert.deepEqual(failure.plan, edit()); assert.equal(failure.repairLog.attempts.length, 1);
      assert.equal(failure.repairLog.attempts[0]!.outcome, "unavailable");
      assert.ok(!JSON.stringify(failure.repairLog).includes("private server path"));
      const oldTimeout = AbortSignal.timeout, expired = new AbortController();
      try {
        AbortSignal.timeout = milliseconds => milliseconds === 120000 ? expired.signal : oldTimeout(milliseconds);
        const timed = await run({ proposer: async () => { queueMicrotask(() => expired.abort(new DOMException("Timed out", "TimeoutError"))); return new Promise(() => {}); } });
        assert.deepEqual(timed.plan, edit()); assert.equal(timed.repairLog.attempts.length, 1);
        assert.match(timed.repairLog.attempts[0]!.reason, /time budget/);
      } finally { AbortSignal.timeout = oldTimeout; }
    });
    await t.test("caller cancellation propagates during a proposal instead of publishing a fallback result", async () => {
      const controller = new AbortController();
      const running = run({ signal: controller.signal, proposer: async () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
      await assert.rejects(running, { name: "AbortError" });
      await assert.rejects(run({ signal: controller.signal }), { name: "AbortError" });
    });
  } finally {
    config.aiEnabled = configured;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
