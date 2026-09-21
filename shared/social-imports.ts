export class SocialImportError extends Error {}

/** Accept video links only, never search queries, profiles, playlists or arbitrary URLs. */
export function socialVideoLink(input: string): { url: string; platform: string } {
  const invalid = () => new SocialImportError("Paste a direct TikTok video, Instagram Reel/post, or YouTube video/Shorts link.");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || input.length > 2048) throw invalid();
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"].includes(host)) {
    const id = host.endsWith("youtu.be") ? pathname.slice(1).replace(/\/$/u, "") : pathname === "/watch"
      ? url.searchParams.get("v") : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/u.exec(pathname)?.[1];
    if (!id || !/^[\w-]{11}$/u.test(id)) throw invalid();
    return { platform: "YouTube", url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (["instagram.com", "www.instagram.com", "m.instagram.com"].includes(host)) {
    const match = /^\/(?:(?!share\/)[\w.]+\/)?(reel|reels|p|tv)\/([\w-]+)\/?$/u.exec(pathname);
    if (!match) throw invalid();
    return { platform: "Instagram", url: `https://www.instagram.com/${match[1] === "reels" ? "reel" : match[1]}/${match[2]}/` };
  }
  if (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host) && /^\/@[^/]+\/video\/\d+\/?$/u.test(pathname))
    return { platform: "TikTok", url: `https://www.tiktok.com${pathname}` };
  if ((["vm.tiktok.com", "vt.tiktok.com"].includes(host) && /^\/[\w-]+\/?$/u.test(pathname)) ||
      (["tiktok.com", "www.tiktok.com"].includes(host) && /^\/t\/[\w-]+\/?$/u.test(pathname)))
    return { platform: "TikTok", url: `https://${host}${pathname}` };
  throw invalid();
}
