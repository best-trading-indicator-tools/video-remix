/** Local sampled picture evidence, not a platform duplicate/originality score. */
export interface VisualIdentity {
  version: 1;
  duration: number;
  frames: { at: number; full: { hash: string; mask: string }; portrait: { hash: string; mask: string } }[];
}
export interface HistoryMatch {
  kind: "exact" | "similar-source" | "similar-export";
  matchedFrames?: number;
  sampledFrames?: number;
}
