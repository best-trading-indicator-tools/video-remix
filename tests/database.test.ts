import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WorkspaceDatabase, type WorkspaceSnapshot } from "../server/database.js";
import type { ExportHistoryEntry } from "../shared/types.js";

const entry = (id: string): ExportHistoryEntry => ({ id, jobId: id, sourceId: "source", sourceFingerprint: "fingerprint", sourceName: "source.mp4", title: `Idea ${id}`, cuts: [{ start: 0, end: 10 }], sourceText: "A complete idea", outputDuration: 10, createdAt: "2026-09-16T12:00:00.000Z", revision: 1, stockShots: [], publications: [{ platform: "instagram", account: "channel", publishedAt: "2026-09-16T12:30:00.000Z" }] });
const empty = () => ({ sources: [], attachments: [], jobs: [], broll: [] });

test("legacy workspace migrates once with unchanged backup and survives restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sqlite-migration-"));
  let db: WorkspaceDatabase | undefined;
  try {
    const original = JSON.stringify({ ...empty(), sources: [{ id: "source", name: "retained source" }], history: [entry("export")] });
    await writeFile(path.join(directory, "state.json"), original);
    db = new WorkspaceDatabase(path.join(directory, "remixer.sqlite")); await db.initialize();
    assert.equal(await readFile(path.join(directory, "state.json.pre-sqlite.bak"), "utf8"), original);
    assert.equal(await readFile(path.join(directory, "state.json"), "utf8"), original);
    assert.equal((await stat(db.filename)).mode & 0o777, 0o600);
    const active = db.loadActive(), updated = [...db.history()][0]!;
    updated.publications[0]!.account = "updated channel";
    db.save(active, [updated]); db.close();
    db = new WorkspaceDatabase(path.join(directory, "remixer.sqlite")); await db.initialize();
    assert.equal([...db.history()][0]!.publications[0]!.account, "updated channel", "Stale JSON cannot overwrite the database on restart");
    assert.deepEqual(db.loadActive(), active);
    assert.equal(db.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("large history saves only the changed record; failed transactions roll back all changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sqlite-large-history-"));
  const db = new WorkspaceDatabase(path.join(directory, "remixer.sqlite"));
  try {
    await db.initialize(); db.loadActive();
    const history = Array.from({ length: 10000 }, (_, i) => entry(String(i)));
    const active = { ...empty(), jobs: [{ id: "job", status: "completed" }] };
    db.save(active, history);
    db.db.exec(`CREATE TABLE audit (id TEXT); CREATE TRIGGER track_history AFTER UPDATE ON history BEGIN INSERT INTO audit VALUES(new.id); END;`);
    const edited = { ...history[250]!, publications: [] };
    db.save(active, [edited]);
    assert.deepEqual(db.db.prepare("SELECT id FROM audit").all().map(row => row.id), ["250"]);
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM history").get()!.n, 10000);
    db.db.exec(`CREATE TRIGGER fail_write BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT,'disk full simulation'); END;`);
    assert.throws(() => db.save({ ...active, jobs: [{ id: "changed" }] }, [{ ...edited, title: "Must roll back" }]));
    assert.deepEqual(db.loadActive(), active);
    assert.equal([...db.history({ id: "250" })][0]!.title, edited.title);
    db.db.exec("DROP TRIGGER fail_write");
    db.save(active, [{ ...edited, title: "Retry saved" }]);
    assert.equal([...db.history({ id: "250" })][0]!.title, "Retry saved");
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("invalid legacy data cannot create an initialized empty workspace", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sqlite-invalid-"));
  const db = new WorkspaceDatabase(path.join(directory, "remixer.sqlite"));
  try {
    await writeFile(path.join(directory, "state.json"), "{broken");
    await assert.rejects(db.initialize());
    assert.equal(db.db.prepare("SELECT count(*) AS n FROM metadata").get()!.n, 0);
    const repaired: WorkspaceSnapshot = { ...empty(), history: [entry("recovered")] };
    await writeFile(path.join(directory, "state.json"), JSON.stringify(repaired));
    await db.initialize();
    assert.equal([...db.history()][0]!.id, "recovered");
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
