/** Editorial findings describe this saved edit; they are not platform predictions. */
export const EDITORIAL_POLICY_VERSION = "editorial-review-v1";
export const SEMANTIC_EDITORIAL_CHECKS = ["opening-context", "ending-complete", "hook-supported", "meaning-preserved", "captions-supported"] as const;
export type SemanticEditorialCheck = typeof SEMANTIC_EDITORIAL_CHECKS[number];
export type EditorialCheckName = SemanticEditorialCheck | "source-evidence" | "cut-boundaries" | "caption-timing" | "plan-structure";
export interface EditorialEvidence {
  sourceId: string;
  /** Original source seconds, never output seconds. */
  start: number;
  end: number;
  quote: string;
  cutIndex?: number;
}
export interface EditorialIssue {
  code: string;
  check: EditorialCheckName;
  severity: "warning" | "error";
  origin: "structural" | "semantic";
  message: string;
  evidence: EditorialEvidence[];
  outputStart?: number;
  outputEnd?: number;
}
export interface EditorialCheck {
  check: EditorialCheckName;
  status: "pass" | "needs-review" | "unavailable" | "not-applicable";
  origin: "structural" | "semantic";
  message: string;
}
export interface EditorialCoverage {
  source: "word-timed" | "segment-only" | "missing";
  semantic: "complete" | "partial" | "unavailable";
  selectedWords: number;
  totalSelectedWords: number;
  neighboringContext: boolean;
  omittedChecks: string[];
  sourceVisuals: false;
  renderedAudio: false;
}
export interface EditorialReport {
  status: "pass" | "needs-review" | "unavailable";
  checkedAt: string;
  policyVersion: string;
  /** Configured model identifier; an immutable weight digest is not implied. */
  modelVersion: string | null;
  /** Present only when a configured provider review was attempted. */
  provider?: "deepseek";
  checks: EditorialCheck[];
  issues: EditorialIssue[];
  coverage: EditorialCoverage;
}
export interface EditorialSourceExcerpt extends EditorialEvidence {
  role: "selected" | "context";
  outputStart?: number;
  outputEnd?: number;
}
export interface EditorialReviewRequest {
  policyVersion: string;
  language: string;
  hook: string;
  narration: boolean;
  outputDuration: number;
  excerpts: EditorialSourceExcerpt[];
  captions: { id: string; start: number; end: number; text: string }[];
  callouts?: { start: number; end: number; text: string }[];
  checks: SemanticEditorialCheck[];
}
/** Test injection uses the same untrusted reply validation as the provider. */
export type EditorialReviewer = (request: EditorialReviewRequest, signal: AbortSignal) => Promise<unknown>;
