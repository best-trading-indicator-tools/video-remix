import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config, paths } from "./config.js";
import { probeMedia } from "./engine.js";
import type { StoredBroll } from "./store.js";
import { brollTokens } from "./broll-text.js";
import { brollSearchBudget, planStockSearch, type SearchMoment } from "./broll-search.js";
import { getVisualSources } from "../shared/visual-sources.js";
import { DEFAULT_BROLL_COUNT, type AutoOptions } from "../shared/types.js";
import { inspectBrollWindows } from "./broll-motion.js";

export type StockProvider = "pixabay" | "pexels";
export const configuredStockProviders = (): StockProvider[] => (["pixabay", "pexels"] as const)
  .filter(provider => Boolean(process.env[provider === "pixabay" ? "PIXABAY_API_KEY" : "PEXELS_API_KEY"]?.trim()));
export const stockBrollConfigured = (providers: readonly StockProvider[] = ["pixabay", "pexels"]) =>
  configuredStockProviders().some(provider => providers.includes(provider));
export function stockProvidersForEdit(options?: AutoOptions): StockProvider[] {
  const selected = getVisualSources(options).filter((source): source is StockProvider => source === "pixabay" || source === "pexels");
  return selected.length ? selected : configuredStockProviders();
}
const providerLabel = (provider: StockProvider) => provider === "pexels" ? "Pexels" : "Pixabay";
const rendition = z.object({
  url: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  size: z.number().nonnegative(),
});
const hitSchema = z.object({
  provider: z.enum(["pixabay", "pexels"]).default("pixabay"),
  id: z.number().int().positive(),
  pageURL: z.string(),
  type: z.enum(["animation", "film"]),
  tags: z.string().max(2000),
  duration: z.number().min(1.5).max(86400),
  user: z.string().max(200),
  // Pixabay can include unavailable renditions with zero dimensions. One bad
  // rendition must not discard an asset that also has a valid, safe video.
  videos: z.record(z.string(), z.unknown()).transform(videos =>
    Object.fromEntries(Object.entries(videos).flatMap(([name, video]) => {
      const parsed = rendition.safeParse(video);
      return parsed.success ? [[name, parsed.data]] : [];
    }))),
});
type StockHit = z.infer<typeof hitSchema>;
const responseSchema = z.object({ hits: z.array(z.unknown()).max(200) });
const maxBytes = () => Math.min(config.maxFileSize, 40 * 1024 ** 2);
const day = 24 * 60 * 60 * 1000;
const supportedLanguages = new Set(
  "cs da de en es fr id it hu nl no pl pt ro sk fi sv tr vi th bg ru el ja ko zh".split(
    " ",
  ),
);

function trustedUrl(value: string, hostname: string, prefix: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === hostname &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.startsWith(prefix)
    );
  } catch {
    return false;
  }
}


/** Pexels does not supply tags or file sizes. Use the source page title for
 * lexical matching; actual downloaded bytes are always bounded independently. */
const pexelsVideo = z.object({ id: z.number().int().positive(), url: z.string(), duration: z.number(),
  user: z.object({ name: z.string().max(200) }), video_files: z.array(z.unknown()).max(100) });
function normalizePexels(raw: unknown) {
  const response = z.object({ videos: z.array(z.unknown()).max(200) }).parse(raw);
  return response.videos.flatMap(value => {
    const parsed = pexelsVideo.safeParse(value);
    if (!parsed.success || !trustedUrl(parsed.data.url, "www.pexels.com", "/video/")) return [];
    const item = parsed.data;
    const tags = new URL(item.url).pathname.split("/").filter(Boolean).at(-1)!.replace(/-\d+$/u, "").replace(/-/gu, ", ");
    const files = item.video_files.flatMap(value => {
      const result = z.object({ link: z.string(), file_type: z.literal("video/mp4"), width: z.number().positive(), height: z.number().positive() }).safeParse(value);
      return result.success ? [{ url: result.data.link, width: result.data.width, height: result.data.height, size: 1 }] : [];
    });
    return [{ provider: "pexels", id: item.id, pageURL: item.url, type: "film", tags, duration: item.duration,
      user: item.user.name, videos: Object.fromEntries(files.map((file, index) => [String(index), file])) }];
  });
}
function trustedVideoUrl(value: string) {
  return trustedUrl(value, "cdn.pixabay.com", "/video/") ||
    trustedUrl(value, "videos.pexels.com", "/video-files/") || trustedUrl(value, "videos.pexels.com", "/videos/");
}

async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  if (!response.body) throw new Error("Empty stock response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Stock response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

async function searchStock(
  provider: StockProvider,
  query: string,
  type: "animation" | "all",
  language: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  cacheDir: string,
  searchRound: number,
): Promise<StockHit[]> {
  const params = provider === "pexels" ? new URLSearchParams({ query, per_page: "12" }) : new URLSearchParams({
    q: query,
    video_type: type,
    lang: language,
    per_page: "12",
    safesearch: "true",
  });
  if (searchRound) params.set("page", String(searchRound + 1));
  const cacheKey = createHash("sha256").update(params.toString()).digest("hex");
  const cachePath = path.join(cacheDir, `stock-${provider}-${cacheKey}.json`);
  let data: z.infer<typeof responseSchema> | undefined;
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    if (
      typeof cached.at === "number" &&
      Date.now() >= cached.at &&
      Date.now() - cached.at < day
    )
      data = responseSchema.parse(cached.data);
  } catch {
    signal.throwIfAborted();
  }
  if (!data) {
    if (provider === "pixabay") params.set("key", process.env.PIXABAY_API_KEY!.trim());
    const response = await fetcher(
      provider === "pexels" ? `https://api.pexels.com/v1/videos/search?${params}` : `https://pixabay.com/api/videos/?${params}`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        redirect: "error",
        ...(provider === "pexels" ? { headers: { Authorization: process.env.PEXELS_API_KEY!.trim() } } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Stock search unavailable");
    }
    const raw = JSON.parse((await boundedBody(response, 1024 ** 2)).toString("utf8"));
    data = responseSchema.parse(provider === "pexels" ? { hits: normalizePexels(raw) } : raw);
    await mkdir(cacheDir, { recursive: true });
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ at: Date.now(), data }), {
        mode: 0o600,
      });
      await rename(temporary, cachePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  signal.throwIfAborted();
  return data.hits.flatMap((value) => {
    const parsed = hitSchema.safeParse(value);
    return parsed.success &&
      (type === "all" || parsed.data.type === "animation") &&
      (provider === "pexels" ? trustedUrl(parsed.data.pageURL, "www.pexels.com", "/video/") : trustedUrl(parsed.data.pageURL, "pixabay.com", "/videos/"))
      ? [{ ...parsed.data, provider }]
      : [];
  });
}

async function downloadStock(
  url: string,
  destination: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  if (
    !trustedVideoUrl(url) ||
    !new URL(url).pathname.endsWith(".mp4")
  )
    throw new Error("Invalid stock video URL");
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: "error",
  });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length")) > maxBytes()
  ) {
    await response.body?.cancel();
    throw new Error("Stock download unavailable");
  }
  const reader = response.body.getReader();
  const file = await open(destination, "wx", 0o600);
  let size = 0;
  const hash = createHash("sha256");
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes()) throw new Error("Stock video exceeds size limit");
      await file.writeFile(value);
      hash.update(value);
    }
    if (!size) throw new Error("Empty stock video");
    return { size, contentHash: hash.digest("hex") };
  } finally {
    await reader.cancel().catch(() => undefined);
    await file.close();
  }
}

/** Small, user-triggered searches. Stock files live only for this render. */
export async function findStockBroll({
  moments,
  providers = ["pixabay"],
  searchRound = 0, excludedStockIds = [],
  type = "all",
  language = "en",
  workDir,
  signal,
  onPhase,
  fetcher = fetch,
  cacheDir = paths.analysis,
  probe = probeMedia,
  matching = "tags",
  targetAspect = 9 / 16,
  targetCount = DEFAULT_BROLL_COUNT,
  inspect = inspectBrollWindows,
}: {
  moments: SearchMoment[];
  providers?: StockProvider[];
  searchRound?: number;
  excludedStockIds?: string[];
  type?: "animation" | "all";
  language?: string;
  workDir: string;
  signal: AbortSignal;
  onPhase: (phase: string) => void;
  fetcher?: typeof fetch;
  cacheDir?: string;
  probe?: typeof probeMedia;
  matching?: "tags" | "ai";
  targetAspect?: number;
  targetCount?: number;
  inspect?: typeof inspectBrollWindows;
}): Promise<{ assets: StoredBroll[]; notes: string[] }> {
  signal.throwIfAborted();
  if (!Number.isInteger(searchRound) || searchRound < 0 || searchRound > 2) throw new Error("Invalid stock search pass");
  const assets: StoredBroll[] = [];
  const notes: string[] = [];
  const budget = brollSearchBudget(targetCount);
  if (!Number.isFinite(targetAspect) || targetAspect < 0.1 || targetAspect > 10)
    throw new Error("Invalid stock target aspect ratio");
  const enabledProviders = [...new Set(providers)].filter(provider => configuredStockProviders().includes(provider));
  if (!enabledProviders.length)
    return {
      assets,
      notes: [
        "Stock B-roll needs a configured Pixabay or Pexels API key for the selected provider. Original footage was kept.",
      ],
    };
  // Requested shots plus two spare ideas, with at most two queries and three
  // downloaded/inspected candidates per idea. Failed candidates consume budget.
  // At the largest request this is 12 ideas / 36 clips, without pagination.
  const usable = moments
    .map((moment) => ({ text: moment.text, words: brollTokens(moment.text) }))
    .filter((moment) => moment.words.length);
  const lexical = Array.from(
    { length: Math.min(budget.briefLimit, usable.length) },
    (_, index) =>
      usable[Math.floor((index * usable.length) / Math.min(budget.briefLimit, usable.length))]!,
  );
  onPhase(matching === "ai" ? "Understanding spoken ideas for stock search" : "Finding stock B-roll");
  const semantic = matching === "ai"
    ? await planStockSearch({ moments, language, targetCount, searchRound, signal, cacheDir, fetcher })
    : undefined;
  if (semantic) notes.push(...semantic.notes);
  const selected = semantic ? semantic.briefs.map(brief => ({
    text: moments[brief.momentIndex]!.text,
    words: brollTokens([brief.query, ...(brief.alternateQueries || [])].join(" ")),
    query: brief.query, alternateQueries: brief.alternateQueries || [],
    reason: brief.reason, visual: brief.visual, momentIndex: brief.momentIndex,
  })) : lexical.map(moment => ({ ...moment, query: moment.words.slice(0, 3).join(" ").slice(0, 100),
    alternateQueries: searchRound && moment.words.length > 2 ? [moment.words.slice(0, 2).join(" ")] : [] as string[], reason: undefined, visual: undefined, momentIndex: undefined }));
  const queries = new Map<string, StockHit[]>();
  const used = new Set<string>(excludedStockIds);
  let downloads = 0;
  const unavailable = new Set<StockProvider>();
  if (type === "animation" && enabledProviders.includes("pexels")) { unavailable.add("pexels"); notes.push("Pexels has no animation-only filter. Animation-only searches use selected Pixabay footage."); }
  for (const moment of selected) {
    signal.throwIfAborted();
    if (downloads >= budget.downloadLimit) break;
    const pool = new Map<string, { hit: StockHit; query: string }>();
    for (const query of [moment.query, ...moment.alternateQueries]) for (const provider of enabledProviders) {
      if (unavailable.has(provider)) continue;
      const identity = `${provider}:${query.toLowerCase().replace(/\s+/gu, " ")}`;
      let hits = queries.get(identity);
      if (!hits) {
        onPhase(`Finding existing B-roll on ${providerLabel(provider)}`);
        try {
          hits = await searchStock(provider, query, type,
            semantic ? "en" : supportedLanguages.has(language) ? language : "en",
            signal, fetcher, cacheDir, searchRound);
          queries.set(identity, hits);
        } catch {
          signal.throwIfAborted();
          notes.push(`${providerLabel(provider)} search was unavailable. Other selected providers and already matched clips were still tried.`);
          unavailable.add(provider);
          continue;
        }
      }
      for (const hit of hits) { const key = `${hit.provider}:${hit.id}`; if (!pool.has(key)) pool.set(key, { hit, query }); }
    }
    const prefersFilm = type === "all" &&
      !/\b(animation|animated|cartoon|3d|diagram)\b/iu.test(`${moment.query} ${moment.visual || ""}`);
    const ranked = [...pool.values()]
      .filter(({ hit }) => !used.has(`${hit.provider}:${hit.id}`))
      .map(({ hit, query }) => ({
        hit, query,
        score: brollTokens(hit.tags).filter((word) =>
          moment.words.includes(word),
        ).length,
      }))
      .filter((candidate) => semantic || candidate.score > 0);
    const chosen = ranked.flatMap(({ hit, query, score }) => {
      const file = Object.values(hit.videos)
        .filter(
          (video) =>
            video.size > 0 &&
            video.size <= maxBytes() &&
            Math.max(video.width, video.height) <= 1920 &&
            trustedVideoUrl(video.url) &&
            new URL(video.url).pathname.endsWith(".mp4"),
        )
        .sort((a, b) => {
          const fit = (v: typeof a) => Math.min(v.width / v.height / targetAspect, targetAspect / (v.width / v.height));
          return fit(b) - fit(a) || b.width * b.height - a.width * a.height;
        })[0];
      return file ? [{ hit, file, query, score }] : [];
    }).sort((a, b) => {
      const fit = (v: typeof a.file) => Math.min(v.width / v.height / targetAspect, targetAspect / (v.width / v.height));
      return b.score - a.score ||
        (prefersFilm ? Number(b.hit.type === "film") - Number(a.hit.type === "film") : 0) ||
        fit(b.file) - fit(a.file);
    }).slice(0, 3);
    for (const { hit, file, query } of chosen) {
      if (downloads >= budget.downloadLimit) break;
      used.add(`${hit.provider}:${hit.id}`);
      downloads++;
      const id = randomUUID();
      const filePath = path.join(workDir, `stock-${id}.mp4`);
      try {
        onPhase("Preparing matched stock B-roll");
        const { size, contentHash } = await downloadStock(file.url, filePath, signal, fetcher);
        const media = await probe(filePath);
        signal.throwIfAborted();
        if (media.duration < 1.5 || media.duration > 86400)
          throw new Error("Unsuitable stock duration");
        onPhase("Checking stock motion and framing");
        const windows = await inspect({ ...media, filePath }, targetAspect, signal);
        const window = windows[0];
        if (!window) {
          await rm(filePath, { force: true });
          notes.push("A stock clip had no suitable moving shot in the output crop and was omitted.");
          continue;
        }
        assets.push({
          id,
          name: `${hit.tags.slice(0, 140)} · ${providerLabel(hit.provider)} ${hit.id}.mp4`,
          tags: hit.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 12),
          ...media,
          size,
          createdAt: new Date().toISOString(),
          filePath,
          thumbnailPath: "",
          thumbnailUrl: "",
          url: "",
          selection: { sourceStart: window.sourceStart, duration: window.duration,
            targetAspect, motion: window.motion, cropRetention: window.cropRetention,
            query, ...(moment.reason ? { reason: moment.reason } : {}),
            ...(moment.visual ? { visual: moment.visual, momentIndex: moment.momentIndex } : {}) },
          stock: { providerId: `${hit.provider}:${hit.id}`, rendition: file.url, contentHash,
            retrievedAt: new Date().toISOString(), licenseUrl: hit.provider === "pexels" ? "https://www.pexels.com/license/" : "https://pixabay.com/service/license-summary/" },
          attribution: {
            provider: providerLabel(hit.provider),
            creator: hit.user,
            url: hit.pageURL,
          },
        });
      } catch {
        await rm(filePath, { force: true });
        signal.throwIfAborted();
        notes.push(
          "A stock clip could not be prepared. Original footage was kept for that moment.",
        );
      }
    }
    if (unavailable.size === enabledProviders.length) break;
  }
  return { assets, notes: [...new Set(notes)] };
}
