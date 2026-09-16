export interface ClipSuggestion {
  id: string;
  start: number;
  end: number;
  title: string;
  takeaway: string;
  text: string;
  before: string;
  after: string;
}
export interface ClipDiscoveryResult {
  clips: ClipSuggestion[];
  reviewedSections: number;
  totalSections: number;
  fullCoverage: boolean;
  notes: string[];
}
export type DiscoveryEvent = { type: "progress"; message: string; progress: number }
  | { type: "result"; result: ClipDiscoveryResult } | { type: "error"; message: string };
