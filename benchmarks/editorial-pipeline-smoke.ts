/** Opt-in authored pipeline smoke: npx tsx benchmarks/editorial-pipeline-smoke.ts --run-deepseek
 * At most eight paid DeepSeek requests and 180 seconds. No user media or rendering.
 * Discovery uses a fresh temporary cache; results do not measure human acceptance.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS, type EditPlan, type Transcript } from "../shared/types.js";
import { candidateFromUnits } from "../server/auto-plan.js";
import { editorialAIConfigured, editorialModel } from "../server/editorial-provider.js";
import { repairEditorialPlan } from "../server/editorial-repair.js";
import { writeCreativePlan, type Candidate } from "../server/intelligence.js";
import { buildIdeaContext, discoverSourceIdeas } from "../server/source-ideas.js";
import { editorialSmokeFixtures } from "./editorial-smoke.js";

const MAX_REQUESTS = 8;
const MAX_RUNTIME_MS = 180_000;
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const normalize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") || "";
const emit = (value: unknown) => console.log(JSON.stringify(value));

export function unsupportedHookFixture(): { transcript: Transcript; plan: EditPlan } {
  const text = "This method does not always work. Test it on a small sample first.";
  const words = text.split(" ").map((word, index) => ({ word,
    start: Number((index * 0.32).toFixed(3)), end: Number((index * 0.32 + 0.27).toFixed(3)) }));
  const end = words.at(-1)!.end;
  const duration = Number((end + 0.3).toFixed(3));
  const cuts = [{ start: 0, end: duration }];
  return {
    transcript: { language: "en", duration, segments: [{ start: 0, end, text, words }] },
    plan: { version: 1, revision: 1, sourceId: "authored-complete-qualification", sourceDuration: duration,
      outputDuration: duration, createdAt: "2026-09-15T00:00:00Z", cuts,
      settings: { ...DEFAULT_SETTINGS, speed: 1, volume: 1, muted: false,
        hookText: "This method always works", hookDuration: 2, segments: cuts, audioId: null, subtitleId: null },
      captions: [{ id: "qualification", start: 0, end, text }], visuals: [], media: [], narration: false },
  };
}

export async function runEditorialPipelineSmoke() {
  const available = editorialAIConfigured();
  emit({ provider: "deepseek", model: editorialModel(), available, maxRequests: MAX_REQUESTS,
    maxRuntimeSeconds: MAX_RUNTIME_MS / 1000, authoredTextOnly: true });
  if (!available) {
    emit({ calls: 0, outcome: "unavailable", reason: "Enable AUTO_AI and configure the existing DeepSeek API key and text model." });
    process.exitCode = 1;
    return;
  }

  const startedAt = Date.now();
  const budget = AbortSignal.timeout(MAX_RUNTIME_MS);
  const originalFetch = globalThis.fetch;
  let calls = 0, refusedCalls = 0, planningObserved = false, repairObserved = false;
  let cacheDir: string | undefined;
  // The global guard includes every real provider call made by all three stages.
  // Never forward another endpoint, follow redirects, or log request/response data.
  globalThis.fetch = async (input, init) => {
    budget.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url !== ENDPOINT || method.toUpperCase() !== "POST" || calls >= MAX_REQUESTS) {
      refusedCalls++;
      throw new Error("Authored pipeline request guard stopped this call.");
    }
    const signals = [budget];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    calls++;
    return originalFetch(input, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
  };
  const failure = (error: unknown) => budget.aborted ? "runtime-budget-reached"
    : error instanceof assert.AssertionError ? "source-anchor-assertion-failed"
    : "provider-or-validation-unavailable";

  try {
    cacheDir = await mkdtemp(path.join(tmpdir(), "remix-editorial-pipeline-smoke-"));
    const camera = editorialSmokeFixtures().find(item => item.id === "complete-camera-advice")!;
    const context = buildIdeaContext(camera.transcript, camera.plan.sourceDuration, 30);
    let candidates: Candidate[] = [];
    const discoveryStart = calls;
    try {
      const ideas = await discoverSourceIdeas({ transcript: camera.transcript,
        sourceDuration: camera.plan.sourceDuration, targetDuration: 30, signal: budget, cacheDir });
      candidates = ideas.candidates;
      for (const candidate of candidates) {
        assert.ok(candidate.idea, "Discovery must return source-unit anchors");
        const original = candidateFromUnits(context.units, candidate.idea.firstUnit,
          candidate.idea.lastUnit, camera.plan.sourceDuration);
        assert.equal(candidate.start, original.start);
        assert.equal(candidate.end, original.end);
        assert.equal(candidate.text, original.text);
        assert.ok(candidate.start >= 0 && candidate.end <= camera.plan.sourceDuration && candidate.end > candidate.start);
      }
      emit({ stage: "discovery", fixture: camera.id, calls: calls - discoveryStart,
        status: !ideas.analyzed ? "unavailable-or-invalid" : candidates.length ? "validated-source-proposals" : "no-idea-proposed",
        coverage: ideas.coverage, candidateCount: candidates.length,
        sourceAnchorsValidated: candidates.length > 0,
        ideas: candidates.map(candidate => ({ ...candidate.idea, start: candidate.start, end: candidate.end })) });
    } catch (error) {
      candidates = [];
      emit({ stage: "discovery", status: failure(error), calls: calls - discoveryStart });
    }

    const packagingStart = calls;
    if (candidates.length && !budget.aborted) {
      try {
        const creative = await writeCreativePlan(candidates, 1, camera.transcript.language, false, budget);
        if (creative) {
          const selected = candidates[creative.windowIndex];
          assert.ok(selected?.idea, "Selected packaging source must be one validated discovered candidate");
          const original = candidateFromUnits(context.units, selected.idea.firstUnit,
            selected.idea.lastUnit, camera.plan.sourceDuration);
          assert.equal(selected.text, original.text);
          assert.equal(selected.start, original.start);
          assert.equal(selected.end, original.end);
          planningObserved = creative.hookRewritten;
          emit({ stage: "selection-and-packaging", calls: calls - packagingStart,
            status: creative.hookRewritten ? "validated-model-output" : "built-in-text-fallback",
            selectedIdea: selected.idea, packagingSource: { start: selected.start, end: selected.end, text: selected.text },
            sourceAnchorsValidated: true, hook: creative.hook, callouts: creative.callouts,
            limitation: "Validated source selection and output structure do not prove the heading preserves meaning." });
        } else emit({ stage: "selection-and-packaging", status: "unavailable-or-invalid", calls: calls - packagingStart });
      } catch (error) {
        emit({ stage: "selection-and-packaging", status: failure(error), calls: calls - packagingStart });
      }
    } else emit({ stage: "selection-and-packaging", status: "not-run-without-validated-discovery", calls: 0 });

    const repairStart = calls;
    if (!budget.aborted) {
      try {
        const fixture = unsupportedHookFixture();
        const result = await repairEditorialPlan({ ...fixture, maxDuration: 30, signal: budget });
        const initial = result.repairLog.initialReport, final = result.report;
        const initialIssues = initial.issues.map(issue => issue.code), finalIssues = final.issues.map(issue => issue.code);
        const attemptsKept = result.repairLog.attempts.filter(attempt => attempt.outcome === "accepted").length;
        const sourceSpeechUnchanged = JSON.stringify(result.plan.cuts) === JSON.stringify(fixture.plan.cuts);
        const hook = normalize(result.plan.settings.hookText);
        const correctedHookIsSourceQuote = Boolean(hook) && (` ${normalize(fixture.transcript.segments[0]!.text)} `).includes(` ${hook} `);
        repairObserved = initial.coverage.semantic === "complete" && initialIssues.includes("hook-supported") &&
          attemptsKept > 0 && final.status === "pass" && final.coverage.semantic === "complete" &&
          sourceSpeechUnchanged && correctedHookIsSourceQuote && result.plan.settings.hookText !== fixture.plan.settings.hookText;
        emit({ stage: "grounded-hook-repair", fixture: "authored-complete-qualification", calls: calls - repairStart,
          expectedBehaviorObserved: repairObserved, initialStatus: initial.status, initialSemanticCoverage: initial.coverage.semantic,
          initialIssueCodes: initialIssues, finalStatus: final.status, finalSemanticCoverage: final.coverage.semantic,
          finalIssueCodes: finalIssues, attempts: result.repairLog.attempts.map(attempt => ({ attempt: attempt.attempt,
            outcome: attempt.outcome, targetCodes: attempt.targetCodes, followUpStatus: attempt.afterReport?.status ?? null })),
          attemptsKept, sourceSpeechUnchanged, correctedHookIsSourceQuote,
          originalHook: fixture.plan.settings.hookText, finalHook: result.plan.settings.hookText,
          stopReason: result.repairLog.stopReason });
      } catch (error) {
        emit({ stage: "grounded-hook-repair", status: failure(error), calls: calls - repairStart });
      }
    } else emit({ stage: "grounded-hook-repair", status: "not-run-runtime-budget-reached", calls: 0 });
  } catch (error) {
    emit({ stage: "runner", status: failure(error) });
  } finally {
    globalThis.fetch = originalFetch;
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    emit({ calls, refusedCalls, seconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      planningExpectedBehaviorObserved: planningObserved, repairExpectedBehaviorObserved: repairObserved,
      outcome: planningObserved && repairObserved ? "expected-authored-behavior-observed" : "expected-authored-behavior-not-established",
      limitation: "Two authored text scenarios; no video rendered, human acceptance measured, or platform outcome established." });
    if (!planningObserved || !repairObserved) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--run-deepseek")) await runEditorialPipelineSmoke();
  else emit({ usage: "npx tsx benchmarks/editorial-pipeline-smoke.ts --run-deepseek", calls: 0,
    maxRequests: MAX_REQUESTS, maxRuntimeSeconds: MAX_RUNTIME_MS / 1000,
    fixtures: ["complete-camera-advice: discovery and source-anchored packaging", "complete qualification with an unsupported hook: grounded repair and recheck"] });
}
