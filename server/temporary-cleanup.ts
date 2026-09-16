import { lstat, opendir, rm } from "node:fs/promises";
import path from "node:path";

const day = 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const cache = /^(stock-(?:pexels|pixabay|brief)-|broll-)[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/u;

/** Only disposable, app-owned paths qualify. Media libraries and history are never scanned. */
export async function cleanupTemporaryFiles(options: {
  analysis: string; work: string; protectedJobIds: () => ReadonlySet<string>; now?: number; maxRemovals?: number;
}) {
  const now = options.now ?? Date.now();
  const limit = options.maxRemovals ?? 500;
  let removed = 0;
  for (const kind of ["analysis", "work"] as const) {
    const directory = options[kind];
    const directoryInfo = await lstat(directory).catch(() => undefined);
    if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) continue;
    for await (const entry of await opendir(directory)) {
      if (removed >= limit) return removed;
      if (kind === "analysis" ? !cache.test(entry.name) : !uuid.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const info = await lstat(filename).catch(() => undefined);
      if (!info || info.isSymbolicLink()) continue;
      if (kind === "analysis" ? !info.isFile() : !info.isDirectory()) continue;
      const ttl = kind === "work" ? 2 * day
        : /^stock-(pexels|pixabay)-/u.test(entry.name) || entry.name.endsWith(".tmp") ? day
        : entry.name.startsWith("stock-brief-") ? 7 * day : 30 * day;
      if (Math.max(info.mtimeMs, info.ctimeMs) >= now - ttl) continue;
      // Recheck after filesystem awaits so a job queued during the scan is protected.
      if (kind === "work" && options.protectedJobIds().has(entry.name)) continue;
      await rm(filename, { recursive: kind === "work", force: true });
      removed++;
    }
  }
  return removed;
}
