import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertLinkedSourceUnchanged } from "../server/media-imports.js";

test("linked-source checks tolerate Windows stat API differences without accepting changed originals", async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "linked-source-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = path.join(directory, "original with spaces.mp4");
  const linked = path.join(directory, "managed.mp4");
  await fs.writeFile(original, "original video bytes");
  await fs.symlink(original, linked);
  const { dev, ino, size, mtimeMs } = await fs.stat(original);
  const source = { filePath: linked, fileSignature: { dev, ino, size, mtimeMs } };
  const originalStat = fs.stat;
  // libuv can report a different volume ID via a Windows symlink than via
  // the direct path. All other metadata still identifies the same file.
  const mockedStat = t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
    const info = await originalStat(...args);
    if (args[0] === linked) Object.assign(info, { dev: Number(info.dev) + 1 });
    return info;
  });
  syncBuiltinESMExports();
  t.after(() => { mockedStat.mock.restore(); syncBuiltinESMExports(); });
  assert.notEqual((await fs.stat(linked)).dev, dev, "Fixture reproduces the Windows metadata mismatch");
  await assert.doesNotReject(assertLinkedSourceUnchanged(source));

  const changed = { status: 409, message: /linked original was moved or changed/u };
  for (const key of ["dev", "ino", "size", "mtimeMs"] as const) {
    await assert.rejects(assertLinkedSourceUnchanged({ ...source,
      fileSignature: { ...source.fileSignature, [key]: source.fileSignature[key] + 1 },
    }), changed, `A real ${key} mismatch must still be rejected`);
  }
  await fs.utimes(original, new Date(), new Date(mtimeMs + 5000));
  await assert.rejects(assertLinkedSourceUnchanged(source), changed);

  // Replace the original with a different file with matching size and mtime.
  // Capture after timestamp restoration to avoid filesystem rounding differences.
  await fs.utimes(original, new Date(), new Date(mtimeMs));
  const restored = await fs.stat(original);
  source.fileSignature.mtimeMs = restored.mtimeMs;
  await fs.rename(original, path.join(directory, "moved.mp4"));
  await assert.rejects(assertLinkedSourceUnchanged(source), changed);
  await fs.writeFile(original, "original video bytes");
  await fs.utimes(original, restored.atime, restored.mtime);
  assert.notEqual((await fs.stat(original)).ino, ino);
  await assert.rejects(assertLinkedSourceUnchanged(source), changed);

  await fs.rm(original);
  await fs.mkdir(original);
  await assert.rejects(assertLinkedSourceUnchanged(source), changed);
  await assert.doesNotReject(assertLinkedSourceUnchanged({ filePath: linked }));
});
