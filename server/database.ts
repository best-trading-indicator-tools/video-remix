import { DatabaseSync } from "node:sqlite";
import { chmod, copyFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { ExportHistoryEntry } from "../shared/types.js";

export const collections = ["sources", "attachments", "jobs", "broll"] as const;
type Collection = typeof collections[number];
export type WorkspaceSnapshot = Record<Collection, { id: string }[]> & { history: ExportHistoryEntry[] };
export type HistoryFilter = { id?: string; jobId?: string; fingerprint?: string };

/** One row per record. History is read on demand, never part of routine workspace saves. */
export class WorkspaceDatabase {
  readonly db: DatabaseSync;
  private saved = new Map<string, string>();
  constructor(readonly filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA cache_size=-8192;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL, search_text TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_date ON history(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS history_job ON history(job_id);
      CREATE INDEX IF NOT EXISTS history_source ON history(fingerprint, created_at DESC);`);
  }
  async initialize() {
    await chmod(this.filename, 0o600);
    if (this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get()) return;
    const legacy = path.join(path.dirname(this.filename), "state.json");
    let snapshot: WorkspaceSnapshot | undefined;
    try {
      const contents = await readFile(legacy, "utf8");
      snapshot = JSON.parse(contents);
      if (!snapshot || !collections.slice(0, 3).every(key => Array.isArray(snapshot![key])) ||
        collections.some(key => snapshot![key] !== undefined && !Array.isArray(snapshot![key])) ||
        (snapshot.history !== undefined && !Array.isArray(snapshot.history))) throw new Error("Invalid legacy workspace");
      // The untouched original and this exclusive backup both survive migration.
      const backup = `${legacy}.pre-sqlite.bak`;
      try { await copyFile(legacy, backup, constants.COPYFILE_EXCL); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await readFile(backup, "utf8") !== contents) throw new Error("Existing migration backup differs from state.json; preserve both before retrying migration.");
      }
      await chmod(backup, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.transaction(() => {
      if (snapshot) {
        for (const collection of [...collections, "history"] as const) {
          const records = snapshot[collection] || [];
          if (new Set(records.map(record => record.id)).size !== records.length) throw new Error(`Duplicate IDs in legacy ${collection}`);
        }
        for (const collection of collections) for (const record of snapshot[collection] || []) this.writeRecord(collection, record);
        for (const entry of snapshot.history || []) this.writeHistory(entry);
      }
      this.db.prepare("INSERT INTO metadata VALUES ('initialized','1')").run();
    });
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  loadActive() {
    const result = { sources: [], attachments: [], jobs: [], broll: [] } as Record<Collection, { id: string }[]>;
    this.saved.clear();
    for (const row of this.db.prepare("SELECT collection,id,data FROM records ORDER BY rowid").iterate()) {
      const key = row.collection as Collection;
      if (!collections.includes(key)) continue;
      result[key].push(JSON.parse(row.data as string));
      this.saved.set(`${key}:${row.id}`, row.data as string);
    }
    return result;
  }
  private writeRecord(collection: Collection, record: { id: string }, serialized = JSON.stringify(record)) {
    if (!record.id) throw new Error(`Missing ID in ${collection}`);
    this.db.prepare("INSERT INTO records VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data").run(collection, record.id, serialized);
  }
  private writeHistory(entry: ExportHistoryEntry) {
    if (!entry.id || !entry.jobId || !entry.sourceFingerprint || !entry.createdAt) throw new Error("Invalid history record");
    this.db.prepare(`INSERT INTO history VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      job_id=excluded.job_id,fingerprint=excluded.fingerprint,created_at=excluded.created_at,search_text=excluded.search_text,data=excluded.data`)
      .run(entry.id, entry.jobId, entry.sourceFingerprint, entry.createdAt, `${entry.title} ${entry.sourceName}`.toLocaleLowerCase(), JSON.stringify(entry));
  }
  save(active: Record<Collection, { id: string }[]>, history: ExportHistoryEntry[] = [], replaceHistory = false) {
    const next = new Map<string, string>();
    this.transaction(() => {
      for (const collection of collections) for (const record of active[collection]) {
        const key = `${collection}:${record.id}`, data = JSON.stringify(record);
        if (next.has(key)) throw new Error(`Duplicate ID in ${collection}`);
        next.set(key, data);
        if (this.saved.get(key) !== data) this.writeRecord(collection, record, data);
      }
      for (const key of this.saved.keys()) if (!next.has(key)) {
        const split = key.indexOf(":");
        this.db.prepare("DELETE FROM records WHERE collection=? AND id=?").run(key.slice(0, split), key.slice(split + 1));
      }
      if (replaceHistory) this.db.exec("DELETE FROM history");
      for (const entry of history) this.writeHistory(entry);
    });
    this.saved = next;
  }
  *history(filter: HistoryFilter = {}): Generator<ExportHistoryEntry> {
    const conditions: string[] = [], values: string[] = [];
    for (const [key, column] of [["id", "id"], ["jobId", "job_id"], ["fingerprint", "fingerprint"]] as const)
      if (filter[key] !== undefined) { conditions.push(`${column}=?`); values.push(filter[key]!); }
    for (const row of this.db.prepare(`SELECT data FROM history${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY created_at DESC,id DESC`).iterate(...values))
      yield JSON.parse(row.data as string);
  }
  close() { this.db.close(); }
}
