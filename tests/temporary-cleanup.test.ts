import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cleanupTemporaryFiles } from "../server/temporary-cleanup.js";
const day = 86400000;

test("temporary cleanup expires stock caches and abandoned work while protecting records, active media and symlink targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "temporary-cleanup-"));
  const analysis = path.join(root, "analysis"), work = path.join(root, "work");
  await mkdir(analysis); await mkdir(work);
  const hash = "a".repeat(64);
  const orphan = randomUUID(), active = randomUUID(), linked = randomUUID();
  const cache = path.join(analysis, `stock-pexels-${hash}.json`);
  const brief = path.join(analysis, `stock-brief-${hash}.json`);
  const visual = path.join(analysis, `broll-${hash}.json`);
  const transcript = path.join(analysis, "source-transcript.json");
  const record = path.join(root, "remixer.sqlite"), backup = path.join(root, "state.json.pre-sqlite.bak");
  for (const filename of [cache, brief, visual, transcript, record, backup]) await writeFile(filename, "keep meaningful data");
  for (const id of [orphan, active]) { await mkdir(path.join(work, id)); await writeFile(path.join(work, id, "video.mp4"), "media"); }
  const outside = path.join(root, "originals"); await mkdir(outside); await writeFile(path.join(outside, "original.mp4"), "original");
  await symlink(outside, path.join(work, linked));
  await symlink(record, path.join(analysis, `stock-pixabay-${hash}.json`));
  const options = { analysis, work, protectedJobIds: () => new Set([active]) };
  try {
    assert.equal(await cleanupTemporaryFiles(options), 0, "Fresh temporary files stay intact");
    assert.equal(await cleanupTemporaryFiles({ ...options, now: Date.now() + 3 * day }), 2);
    await assert.rejects(stat(cache), { code: "ENOENT" }); await assert.rejects(stat(path.join(work, orphan)), { code: "ENOENT" });
    assert.equal(await cleanupTemporaryFiles({ ...options, now: Date.now() + 8 * day }), 1);
    assert.equal(await cleanupTemporaryFiles({ ...options, now: Date.now() + 31 * day }), 1);
    for (const filename of [record, backup, transcript]) assert.equal(await readFile(filename, "utf8"), "keep meaningful data");
    assert.equal(await readFile(path.join(work, active, "video.mp4"), "utf8"), "media");
    assert.equal(await readFile(path.join(outside, "original.mp4"), "utf8"), "original");
    assert.equal(await cleanupTemporaryFiles({ ...options, now: Date.now() + 31 * day }), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("each cleanup pass caps removals and checks protected jobs at deletion time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "temporary-cleanup-limit-"));
  const analysis = path.join(root, "analysis"), work = path.join(root, "work");
  await mkdir(analysis); await mkdir(work);
  try {
    for (let i = 0; i < 5; i++) await writeFile(path.join(analysis, `stock-pixabay-${String(i).padStart(64, "a")}.json`), "cache");
    const options = { analysis, work, protectedJobIds: () => new Set<string>(), now: Date.now() + 3 * day, maxRemovals: 2 };
    assert.equal(await cleanupTemporaryFiles(options), 2);
    assert.equal(await cleanupTemporaryFiles(options), 2);
    assert.equal(await cleanupTemporaryFiles(options), 1);
    const active = randomUUID(); await mkdir(path.join(work, active));
    assert.equal(await cleanupTemporaryFiles({ ...options, protectedJobIds: () => new Set([active]) }), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
