import type { EditPlan, Transcript, TranscriptSegment } from "../shared/types.js";
import {
  EDITORIAL_POLICY_VERSION, SEMANTIC_EDITORIAL_CHECKS,
  type EditorialCheck, type EditorialCoverage, type EditorialEvidence, type EditorialIssue,
  type EditorialReport, type EditorialReviewer, type EditorialReviewRequest, type EditorialSourceExcerpt,
} from "../shared/editorial.js";
import { editorialAIConfigured, editorialAIEnabled, editorialModel } from "./editorial-provider.js";
import { editorialReplySchema, deepseekEditorialReviewer, EditorialValidationError } from "./editorial-model.js";
import { AIRequestError } from "./ai-errors.js";

const MAX_EXCERPTS = 80;
const MAX_EVIDENCE_CHARS = 12_000;
const MAX_CAPTION_CHARS = 5_000;
const clean = (text: string) => text.replace(/\s+/gu, " ").trim();
const tokens = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const finite = (value: number) => Number.isFinite(value);
const sourceText = (segment: TranscriptSegment) => clean(segment.words?.length
  ? segment.words.map(word => word.word).join(" ") : segment.text);

export interface EditorialReviewContext {
  request: EditorialReviewRequest;
  structuralIssues: EditorialIssue[];
  structuralChecks: EditorialCheck[];
  coverage: EditorialCoverage;
  validPlan: boolean;
}

/** Build evidence afresh from the actual cuts, not the original candidate or its model summary. */
export function buildEditorialReviewContext(plan: EditPlan, transcript?: Transcript): EditorialReviewContext {
  const issues: EditorialIssue[] = [];
  const checks: EditorialCheck[] = [];
  const excerpts: EditorialSourceExcerpt[] = [];
  const coverage: EditorialCoverage = { source: "missing", semantic: "unavailable", selectedWords: 0,
    totalSelectedWords: 0, neighboringContext: false, omittedChecks: ["source-visuals", "rendered-audio"],
    sourceVisuals: false, renderedAudio: false };
  const add = (issue: Omit<EditorialIssue, "origin">) => {
    if (issues.length < 30) issues.push({ ...issue, origin: "structural" });
  };
  const validPlan = finite(plan.sourceDuration) && plan.sourceDuration > 0 && finite(plan.outputDuration) && plan.outputDuration > 0 &&
    finite(plan.settings.speed) && plan.settings.speed > 0 && plan.cuts.length > 0 && plan.cuts.length <= 60 &&
    plan.cuts.every(cut => finite(cut.start) && finite(cut.end) && cut.start >= 0 && cut.end > cut.start && cut.end <= plan.sourceDuration + 0.001);
  const cutDuration = plan.cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0) / plan.settings.speed;
  const durationMatches = validPlan && Math.abs(cutDuration - plan.outputDuration) < 0.1;
  if (!validPlan || !durationMatches) add({ code: "invalid-plan", check: "plan-structure", severity: "error",
    message: "The saved cuts, source bounds, playback speed or output duration are inconsistent.", evidence: [] });
  checks.push({ check: "plan-structure", origin: "structural", status: validPlan && durationMatches ? "pass" : "needs-review",
    message: validPlan && durationMatches ? "Cuts and duration agree with the saved plan." : "The saved timeline needs correction." });

  const segments = transcript?.segments || [];
  const hasTranscript = segments.some(segment => sourceText(segment));
  let partialWords = false, truncated = false, characters = 0;
  const selectedSegments = new Set<number>();
  const append = (excerpt: EditorialSourceExcerpt) => {
    if (excerpts.length >= MAX_EXCERPTS || characters + excerpt.quote.length > MAX_EVIDENCE_CHARS) { truncated = true; return false; }
    excerpts.push(excerpt); characters += excerpt.quote.length; return true;
  };
  if (hasTranscript && validPlan) {
    let offset = 0;
    for (const [cutIndex, cut] of plan.cuts.entries()) {
      for (const [index, segment] of segments.entries()) {
        if (!finite(segment.start) || !finite(segment.end) || segment.end <= segment.start || segment.end <= cut.start || segment.start >= cut.end) continue;
        selectedSegments.add(index);
        const words = (segment.words || []).filter(word => finite(word.start) && finite(word.end) && word.end > word.start && word.word.trim());
        if (words.length !== (segment.words || []).length || words.some((word, wordIndex) => wordIndex > 0 && word.start < words[wordIndex - 1]!.start)) partialWords = true;
        if (!words.length) {
          partialWords = true;
          // A partially selected untimed segment cannot establish its selected words.
          if (segment.start >= cut.start && segment.end <= cut.end && sourceText(segment)) {
            const quote = sourceText(segment);
            coverage.totalSelectedWords += tokens(quote).length;
            if (append({ sourceId: `selected-${cutIndex}-${index}`, role: "selected", cutIndex,
              start: segment.start, end: segment.end, quote, outputStart: offset + (segment.start - cut.start) / plan.settings.speed,
              outputEnd: offset + (segment.end - cut.start) / plan.settings.speed })) coverage.selectedWords += tokens(quote).length;
          }
          continue;
        }
        const inside = words.filter(word => word.start >= cut.start - 0.001 && word.end <= cut.end + 0.001);
        const crossing = words.filter(word => (word.start < cut.start - 0.015 && word.end > cut.start + 0.015) ||
          (word.start < cut.end - 0.015 && word.end > cut.end + 0.015));
        if (crossing.length) add({ code: "clipped-word", check: "cut-boundaries", severity: "error",
          message: `Sequence ${cutIndex + 1} starts or ends inside a spoken word.`,
          outputStart: offset, outputEnd: offset + (cut.end - cut.start) / plan.settings.speed,
          evidence: crossing.slice(0, 3).map(word => ({ sourceId: `word-${index}-${words.indexOf(word)}`, start: word.start, end: word.end, quote: clean(word.word), cutIndex })) });
        if (!inside.length) continue;
        const quote = clean(inside.map(word => word.word).join(" "));
        coverage.totalSelectedWords += inside.length;
        if (append({ sourceId: `selected-${cutIndex}-${index}`, role: "selected", cutIndex,
          start: inside[0]!.start, end: inside.at(-1)!.end, quote,
          outputStart: offset + (inside[0]!.start - cut.start) / plan.settings.speed,
          outputEnd: offset + (inside.at(-1)!.end - cut.start) / plan.settings.speed })) coverage.selectedWords += inside.length;
      }
      offset += (cut.end - cut.start) / plan.settings.speed;
    }
    const contextIndices = new Set<number>();
    for (const index of selectedSegments) {
      // Include the full selected segment too: a removed question/negation can be in that same segment.
      for (const nearby of [index - 1, index, index + 1]) if (segments[nearby]) contextIndices.add(nearby);
    }
    for (const index of [...contextIndices].sort((a, b) => a - b)) {
      const segment = segments[index]!;
      if (!finite(segment.start) || !finite(segment.end) || segment.start < 0 || segment.end <= segment.start || !sourceText(segment)) continue;
      append({ sourceId: `context-${index}`, role: "context", start: segment.start, end: segment.end, quote: sourceText(segment) });
    }
    coverage.source = partialWords ? "segment-only" : "word-timed";
    coverage.neighboringContext = contextIndices.size > 0 && !truncated;
  }
  if (!excerpts.some(excerpt => excerpt.role === "selected")) {
    coverage.source = hasTranscript ? "segment-only" : "missing";
    coverage.omittedChecks.push("selected-speech-fidelity");
    checks.push({ check: "source-evidence", status: "unavailable", origin: "structural",
      message: "The selected speech cannot be established from the available transcript." });
  } else {
    checks.push({ check: "source-evidence", status: partialWords || truncated ? "needs-review" : "pass", origin: "structural",
      message: partialWords || truncated ? "Source evidence is incomplete for this edit." : "Selected words and neighboring source context are attached." });
    if (partialWords) add({ code: "word-timing-unavailable", check: "source-evidence", severity: "warning",
      message: "Some selected speech has no word timing. Exact boundaries and selected wording need review.", evidence: [] });
  }
  if (truncated) {
    coverage.omittedChecks.push("full-source-context");
    add({ code: "evidence-truncated", check: "source-evidence", severity: "warning",
      message: "This edit exceeds the bounded review context. Some selected speech or neighboring context was not inspected.", evidence: [] });
  }
  checks.push({ check: "cut-boundaries", origin: "structural",
    status: issues.some(issue => issue.code === "clipped-word") ? "needs-review" : coverage.source !== "word-timed" ? "unavailable" : "pass",
    message: coverage.source !== "word-timed" ? "Word timing is required to check speech boundaries." : "Compared cut boundaries with source word times." });

  let captionCharacters = 0;
  const captions: EditorialReviewRequest["captions"] = [];
  let previousEnd = 0;
  for (const caption of plan.captions) {
    if (!finite(caption.start) || !finite(caption.end) || caption.start < 0 || caption.end <= caption.start ||
      caption.end > plan.outputDuration + 0.001 || caption.start < previousEnd - 0.001 || !caption.text.trim()) {
      add({ code: "caption-timing", check: "caption-timing", severity: "error", message: "A caption is empty, overlaps another cue or falls outside the saved timeline.", evidence: [],
        ...(finite(caption.start) && caption.start >= 0 ? { outputStart: caption.start } : {}) });
    }
    previousEnd = caption.end;
    if (captionCharacters + caption.text.length > MAX_CAPTION_CHARS || captions.length >= 200) { truncated = true; continue; }
    captions.push({ ...caption }); captionCharacters += caption.text.length;
  }
  if (captions.length < plan.captions.length) {
    coverage.omittedChecks.push("full-caption-content");
    add({ code: "captions-truncated", check: "captions-supported", severity: "warning", message: "Some captions exceed the bounded editorial review and still need checking.", evidence: [] });
  }
  checks.push({ check: "caption-timing", origin: "structural", status: plan.captions.length
    ? issues.some(issue => issue.code === "caption-timing") ? "needs-review" : "pass" : "not-applicable",
    message: plan.captions.length ? "Checked cue bounds and overlap on the final timeline." : "This edit has no caption cues." });
  if (plan.narration || plan.audioMediaId || plan.settings.audioId) {
    coverage.omittedChecks.push("replacement-audio-fidelity");
    add({ code: "replacement-audio-unverified", check: "meaning-preserved", severity: "warning",
      message: "Replacement or narrated audio is not verified against these source words. Listen to it and check its meaning.", evidence: [] });
  }
  if (plan.settings.muted || plan.settings.volume === 0) {
    coverage.omittedChecks.push("audible-selected-speech");
    add({ code: "selected-speech-muted", check: "meaning-preserved", severity: "warning",
      message: "The selected source speech is muted. These text checks cannot establish that the silent edit communicates the same idea.", evidence: [] });
  }
  const sourceCallouts = plan.settings.callouts || [];
  const callouts = sourceCallouts.slice(0, 20).map(item => ({ start: item.start, end: item.end, text: item.text.slice(0, 100) }));
  if (sourceCallouts.length > 20 || sourceCallouts.some(item => item.text.length > 100)) {
    truncated = true;
    coverage.omittedChecks.push("full-callout-content");
    add({ code: "callouts-truncated", check: "hook-supported", severity: "warning", message: "Some on-screen callouts exceed the bounded review and still need checking.", evidence: [] });
  }
  const semanticChecks = SEMANTIC_EDITORIAL_CHECKS.filter(check =>
    (check !== "hook-supported" || Boolean(plan.settings.hookText.trim()) || callouts.length > 0) && (check !== "captions-supported" || plan.captions.length > 0));
  for (const check of SEMANTIC_EDITORIAL_CHECKS) if (!semanticChecks.includes(check)) checks.push({
    check, origin: "semantic", status: "not-applicable", message: check === "hook-supported" ? "No hook text is planned." : "No captions are planned." });
  const hook = plan.settings.hookText.slice(0, 200);
  if (hook !== plan.settings.hookText) {
    truncated = true;
    add({ code: "hook-truncated", check: "hook-supported", severity: "warning", message: "The complete hook exceeds the review limit.", evidence: [] });
  }
  if (truncated) coverage.semantic = "partial";
  return { validPlan: validPlan && durationMatches, structuralIssues: issues, structuralChecks: checks, coverage,
    request: { policyVersion: EDITORIAL_POLICY_VERSION, language: transcript?.language || "unknown", hook,
      narration: plan.narration, outputDuration: plan.outputDuration, excerpts, captions, callouts, checks: semanticChecks } };
}

export async function reviewEditorialPlan({ plan, transcript, signal, reviewer = deepseekEditorialReviewer, aiEnabled = editorialAIEnabled() }: {
  plan: EditPlan; transcript?: Transcript; signal: AbortSignal; reviewer?: EditorialReviewer; aiEnabled?: boolean;
}): Promise<EditorialReport> {
  signal.throwIfAborted();
  const context = buildEditorialReviewContext(plan, transcript);
  const report: EditorialReport = { status: "unavailable", checkedAt: new Date().toISOString(), policyVersion: EDITORIAL_POLICY_VERSION,
    modelVersion: null, checks: context.structuralChecks, issues: context.structuralIssues, coverage: context.coverage };
  const unavailable = (message: string, code: string, retryable = false) => {
    report.failure = { code, message, retryable };
    report.coverage.semantic = "unavailable";
    report.coverage.omittedChecks.push(...context.request.checks);
    report.checks.push(...context.request.checks.map(check => ({ check, status: "unavailable" as const, origin: "semantic" as const, message })));
    report.status = report.issues.length ? "needs-review" : "unavailable";
    return report;
  };
  if (!context.validPlan) return unavailable("Correct the saved timeline before editorial review.", "invalid-plan");
  if (!context.request.excerpts.some(excerpt => excerpt.role === "selected")) return unavailable("A transcript of the selected speech is required for editorial review.", "missing-transcript");
  if (!editorialAIEnabled() || !aiEnabled) return unavailable("AI editorial review is disabled. Enable Auto AI to run this check.", "disabled");
  if (!editorialAIConfigured()) return unavailable("Configure a DeepSeek API key and valid model identifier for editorial review.", "configuration");
  report.modelVersion = editorialModel();
  report.provider = "deepseek";
  try {
    const budget = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
    const raw = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(budget.reason);
      budget.addEventListener("abort", abort, { once: true });
      if (budget.aborted) abort();
      else Promise.resolve().then(() => reviewer(structuredClone(context.request), budget))
        .then(resolve, reject).finally(() => budget.removeEventListener("abort", abort));
    });
    const reply = editorialReplySchema.parse(raw);
    budget.throwIfAborted();
    const evidenceById = new Map(context.request.excerpts.map(excerpt => [excerpt.sourceId, excerpt]));
    const expected = new Set(context.request.checks);
    if (reply.checks.length !== expected.size || new Set(reply.checks.map(check => check.check)).size !== expected.size ||
      reply.checks.some(check => !expected.has(check.check))) throw new EditorialValidationError("Incomplete editorial checks");
    // Validate the complete reply before accepting even one verdict.
    const validated = reply.checks.map(check => {
      const evidence: EditorialEvidence[] = check.evidence.map(citation => {
        const original = evidenceById.get(citation.sourceId);
        if (!original || citation.start !== original.start || citation.end !== original.end ||
          !clean(original.quote).includes(clean(citation.quote))) throw new EditorialValidationError("Unsupported editorial evidence");
        return { sourceId: original.sourceId, start: original.start, end: original.end, quote: clean(citation.quote),
          ...(original.cutIndex === undefined ? {} : { cutIndex: original.cutIndex }) };
      });
      if (!check.evidence.some(citation => evidenceById.get(citation.sourceId)?.role === "selected")) throw new EditorialValidationError("Review omitted selected speech");
      return { ...check, evidence };
    });
    for (const check of validated) {
      report.checks.push({ check: check.check, status: check.verdict === "pass" ? "pass" : "needs-review", origin: "semantic", message: check.explanation });
      if (check.verdict !== "pass") report.issues.push({ check: check.check,
        code: check.verdict === "uncertain" ? `${check.check}-uncertain` : check.check,
        severity: check.verdict === "issue" && check.check === "meaning-preserved" ? "error" : "warning",
        origin: "semantic", message: check.explanation, evidence: check.evidence,
        ...(() => {
          const selected = check.evidence.map(item => evidenceById.get(item.sourceId)!).find(item => item.role === "selected");
          return selected ? { outputStart: selected.outputStart, outputEnd: selected.outputEnd } : {};
        })() });
    }
    report.coverage.semantic = context.coverage.semantic === "partial" || context.coverage.source !== "word-timed" ? "partial" : "complete";
    report.status = report.issues.length || report.coverage.semantic !== "complete" ? "needs-review" : "pass";
    return report;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AIRequestError) return unavailable(error.message, error.code, error.retryable);
    if (error instanceof EditorialValidationError)
      return unavailable("DeepSeek returned findings whose source quotations or comparisons could not be verified. Retry the editorial check.", "invalid-evidence", true);
    if (error instanceof Error && error.name === "TimeoutError") {
      const timeout = new AIRequestError("timeout");
      return unavailable(timeout.message, timeout.code, timeout.retryable);
    }
    return unavailable("The editorial answer could not be validated. Retry the editorial check.", "invalid-review", true);
  }
}
