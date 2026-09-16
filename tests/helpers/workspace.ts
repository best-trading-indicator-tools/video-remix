import path from "node:path";
import { WorkspaceDatabase, type WorkspaceSnapshot } from "../../server/database.js";

/** Inspect/update an isolated fixture through its actual durable storage. */
export async function readWorkspaceFile(legacyPath: string, _encoding?: string): Promise<string> {
  const db = new WorkspaceDatabase(path.join(path.dirname(legacyPath), "remixer.sqlite"));
  try { return JSON.stringify({ ...db.loadActive(), history: [...db.history()] }); }
  finally { db.close(); }
}
export async function writeWorkspaceFile(legacyPath: string, contents: string) {
  const db = new WorkspaceDatabase(path.join(path.dirname(legacyPath), "remixer.sqlite"));
  try { db.loadActive(); const snapshot = JSON.parse(contents) as WorkspaceSnapshot; db.save(snapshot, snapshot.history, true); }
  finally { db.close(); }
}
export async function failWorkspaceWrites(directory: string, fail: boolean) {
  const db = new WorkspaceDatabase(path.join(directory, "remixer.sqlite"));
  try {
    for (const table of ["records", "history"]) for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const trigger = `fixture_fail_${table}_${operation}`;
      db.db.exec(fail ? `CREATE TRIGGER ${trigger} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture disk write failure'); END` : `DROP TRIGGER IF EXISTS ${trigger}`);
    }
  } finally { db.close(); }
}
