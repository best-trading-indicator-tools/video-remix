export interface DraftHistoryMatch {
  id: string;
  title: string;
  overlapSeconds: number;
  draftCoverage: number;
  createdAt: string;
  publications: { platform: string; publishedAt: string; account?: string; url?: string }[];
}
export interface DraftHistoryResult {
  id: string;
  status: "checked" | "source-unavailable" | "identity-unavailable";
  matches: DraftHistoryMatch[];
  total: number;
}
