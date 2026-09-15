import type { EditPlanChanges } from "./types.js";
import type { EditorialEvidence, EditorialIssue, EditorialReport, EditorialReviewRequest } from "./editorial.js";

export const EDITORIAL_REPAIR_POLICY_VERSION = "editorial-repair-v1";
export interface EditorialRepairProposal {
  targetCodes: string[];
  summary: string;
  hook?: { text: string; evidence: EditorialEvidence[] };
  extensions?: { cutIndex: number; start?: number; end?: number; evidence: EditorialEvidence[] }[];
  captions?: { id: string; text: string; evidence: EditorialEvidence[] }[];
}
export interface EditorialBoundaryChoice { time: number; sourceId: string; quote: string }
export interface EditorialRepairRequest {
  policyVersion: string;
  attempt: number;
  review: EditorialReviewRequest;
  findings: EditorialIssue[];
  maxDuration: number;
  cuts: { start: number; end: number }[];
  boundaryChoices: { cutIndex: number; start: EditorialBoundaryChoice[]; end: EditorialBoundaryChoice[] }[];
  previousRejections: string[];
}
/** Replies remain untrusted and are compiled and reviewed independently. */
export type EditorialRepairProposer = (request: EditorialRepairRequest, signal: AbortSignal) => Promise<unknown>;
export interface EditorialRepairAttempt {
  attempt: number;
  outcome: "accepted" | "rejected" | "unavailable";
  targetCodes: string[];
  patch?: EditPlanChanges;
  summary: string;
  reason: string;
  beforeReport: EditorialReport;
  afterReport?: EditorialReport;
}
/** Automatic work is separate from human correction counts and user revisions. */
export interface EditorialRepairLog {
  policyVersion: string;
  modelVersion: string | null;
  initialReport: EditorialReport;
  finalReport: EditorialReport;
  attempts: EditorialRepairAttempt[];
  stopReason: string;
}
