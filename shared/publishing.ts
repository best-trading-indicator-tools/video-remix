import type { ExportHistoryEntry, PostMetrics, PublishingPlatform, ReachAssessment } from "./types.js";

export const PLATFORM_NAMES: Record<PublishingPlatform, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
export const REACH_LABELS: Record<ReachAssessment, string> = {
  unknown: "Not assessed", normal: "No restriction observed", suspected: "Suspected reach restriction",
  confirmed: "Restriction confirmed by platform notice", resolved: "Restriction resolved",
};
export function validPublicationUrl(platform: PublishingPlatform, value: string): boolean {
  try {
    const url = new URL(value);
    const domains = platform === "youtube" ? ["youtube.com", "youtu.be"] : [`${platform}.com`];
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
/** Unknown legacy posts stay together; identified posts/accounts never overwrite each other. */
export function latestPostObservations(entry: ExportHistoryEntry): PostMetrics[] {
  const latest = new Map<string, PostMetrics>();
  for (const post of entry.measurements?.posts || []) {
    if (!post || !Object.hasOwn(PLATFORM_NAMES, post.platform) || !Number.isFinite(Date.parse(post.measuredAt))) continue;
    const key = `${post.platform}:${post.publicationId || "legacy"}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(post.measuredAt) >= Date.parse(previous.measuredAt)) latest.set(key, post);
  }
  return [...latest.values()].sort((a, b) => a.platform.localeCompare(b.platform));
}
