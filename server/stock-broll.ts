import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config, paths } from "./config.js";
import { probeMedia } from "./engine.js";
import type { StoredBroll } from "./store.js";
import { brollTokens } from "./broll-text.js";
import { brollSearchBudget, planStockSearch, type SearchMoment } from "./broll-search.js";
import { DEFAULT_BROLL_COUNT } from "../shared/types.js";
import { inspectBrollWindows } from "./broll-motion.js";

export const stockBrollConfigured = () =>
  Boolean(process.env.PIXABAY_API_KEY?.trim());
const rendition = z.object({
  url: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  size: z.number().nonnegative(),
});
const hitSchema = z.object({
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
  query: string,
  type: "animation" | "all",
  language: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
  cacheDir: string,
): Promise<StockHit[]> {
  const params = new URLSearchParams({
    q: query,
    video_type: type,
    lang: language,
    per_page: "12",
    safesearch: "true",
  });
  const cacheKey = createHash("sha256").update(params.toString()).digest("hex");
  const cachePath = path.join(cacheDir, `stock-pixabay-${cacheKey}.json`);
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
    params.set("key", process.env.PIXABAY_API_KEY!.trim());
    const response = await fetcher(
      `https://pixabay.com/api/videos/?${params}`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Stock search unavailable");
    }
    data = responseSchema.parse(
      JSON.parse((await boundedBody(response, 1024 ** 2)).toString("utf8")),
    );
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
      trustedUrl(parsed.data.pageURL, "pixabay.com", "/videos/")
      ? [parsed.data]
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
    !trustedUrl(url, "cdn.pixabay.com", "/video/") ||
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
  const assets: StoredBroll[] = [];
  const notes: string[] = [];
  const budget = brollSearchBudget(targetCount);
  if (!Number.isFinite(targetAspect) || targetAspect < 0.1 || targetAspect > 10)
    throw new Error("Invalid stock target aspect ratio");
  if (!stockBrollConfigured())
    return {
      assets,
      notes: [
        "Stock B-roll needs PIXABAY_API_KEY on the server. Original footage was kept.",
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
    ? await planStockSearch({ moments, language, targetCount, signal, cacheDir, fetcher })
    : undefined;
  if (semantic) notes.push(...semantic.notes);
  const selected = semantic ? semantic.briefs.map(brief => ({
    text: moments[brief.momentIndex]!.text,
    words: brollTokens([brief.query, ...(brief.alternateQueries || [])].join(" ")),
    query: brief.query, alternateQueries: brief.alternateQueries || [],
    reason: brief.reason, visual: brief.visual, momentIndex: brief.momentIndex,
  })) : lexical.map(moment => ({ ...moment, query: moment.words.slice(0, 3).join(" ").slice(0, 100),
    alternateQueries: [] as string[], reason: undefined, visual: undefined, momentIndex: undefined }));
  const queries = new Map<string, StockHit[]>();
  const used = new Set<number>();
  let downloads = 0;
  let searchUnavailable = false;
  for (const moment of selected) {
    signal.throwIfAborted();
    if (downloads >= budget.downloadLimit) break;
    const pool = new Map<number, { hit: StockHit; query: string }>();
    for (const query of [moment.query, ...moment.alternateQueries]) {
      if (searchUnavailable) break;
      const identity = query.toLowerCase().replace(/\s+/gu, " ");
      let hits = queries.get(identity);
      if (!hits) {
        onPhase("Finding existing B-roll on Pixabay");
        try {
          hits = await searchStock(query, type,
            semantic ? "en" : supportedLanguages.has(language) ? language : "en",
            signal, fetcher, cacheDir);
          queries.set(identity, hits);
        } catch {
          signal.throwIfAborted();
          notes.push("Pixabay search was unavailable. The edit continues with any clips already matched.");
          searchUnavailable = true;
          break;
        }
      }
      for (const hit of hits) if (!pool.has(hit.id)) pool.set(hit.id, { hit, query });
    }
    const prefersFilm = type === "all" &&
      !/\b(animation|animated|cartoon|3d|diagram)\b/iu.test(`${moment.query} ${moment.visual || ""}`);
    const ranked = [...pool.values()]
      .filter(({ hit }) => !used.has(hit.id))
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
            trustedUrl(video.url, "cdn.pixabay.com", "/video/") &&
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
      used.add(hit.id);
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
          name: `${hit.tags.slice(0, 140)} · Pixabay ${hit.id}.mp4`,
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
          stock: { providerId: `pixabay:${hit.id}`, rendition: file.url, contentHash,
            retrievedAt: new Date().toISOString(), licenseUrl: "https://pixabay.com/service/license-summary/" },
          attribution: {
            provider: "Pixabay",
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
    if (searchUnavailable) break;
  }
  return { assets, notes: [...new Set(notes)] };
}
