import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { paths } from "../server/config.js";
import { historyThumbnailExists, historyThumbnailPath, retainHistoryThumbnail } from "../server/history-thumbnails.js";

const exec = promisify(execFile);
const pixel = async (file: string) => {
  const result = await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file,
    "-frames:v", "1", "-vf", "scale=1:1", "-filter_threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { encoding: "buffer", timeout: 10_000, maxBuffer: 1024 * 1024 });
  return [...result.stdout];
};

test("history frames retain rendered pictures and selected source moments independently of videos", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-frames-"));
  const previous = paths.historyThumbnails;
  paths.historyThumbnails = path.join(directory, "retained frames");
  t.after(async () => { paths.historyThumbnails = previous; await rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, "source with spaces.mp4");
  const output = path.join(directory, "blue export.mp4");
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=red:size=320x180:rate=24:duration=2",
    "-f", "lavfi", "-i", "color=blue:size=320x180:rate=24:duration=2",
    "-f", "lavfi", "-i", "color=lime:size=320x180:rate=24:duration=2",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]",
    "-filter_complex_threads", "1", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", source], { timeout: 15_000 });
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", "2", "-i", source,
    "-t", "1.5", "-c:v", "libx264", "-threads", "1", output], { timeout: 15_000 });

  await t.test("the retained image shows the export, stays small, and survives its video being removed", async () => {
    const entry = { id: "export-blue", outputDuration: 1.5 };
    const preview = await retainHistoryThumbnail(entry, output);
    assert.equal(preview?.kind, "export");
    assert.equal(preview?.url, "/api/history/export-blue/thumbnail");
    const file = historyThumbnailPath(entry.id);
    const content = await readFile(file);
    assert.deepEqual([...content.subarray(0, 3)], [255, 216, 255]);
    assert.ok(content.length < 100_000);
    const probed = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", file], { timeout: 10_000 });
    const media = JSON.parse(probed.stdout).streams[0];
    assert.ok(media.width <= 480 && media.height <= 480 && media.width > media.height);
    const [r, g, b] = await pixel(file);
    assert.ok(b! > 220 && r! < 25 && g! < 25, "The exported blue cut must not show the original red opening");
    await rm(output);
    assert.deepEqual(await retainHistoryThumbnail(entry), preview);
    assert.deepEqual(await readFile(file), content);
  });

  await t.test("legacy fallback uses the recorded source interval and retains its source label", async () => {
    const entry = { id: "source-green", outputDuration: 1.5 };
    const preview = await retainHistoryThumbnail(entry, path.join(directory, "expired.mp4"), undefined, { filePath: source, start: 4, end: 5.5 });
    assert.equal(preview?.kind, "source");
    const [r, g, b] = await pixel(historyThumbnailPath(entry.id));
    assert.ok(g! > 220 && r! < 25 && b! < 25, "Fallback must seek to the green excerpt instead of the red source opening");
    assert.deepEqual(await retainHistoryThumbnail({ ...entry, thumbnailKind: "source" }), preview);
  });

  await t.test("managed source links tolerate Windows stat differences while changed originals are rejected", async t => {
    const linked = path.join(directory, "linked source.mp4");
    await symlink(source, linked);
    const { dev, ino, size, mtimeMs } = await stat(source);
    const signature = { dev, ino, size, mtimeMs };
    const originalStat = fs.stat;
    const mockedStat = t.mock.method(fs, "stat", async (...args: Parameters<typeof fs.stat>) => {
      const info = await originalStat(...args);
      if (args[0] === linked) Object.assign(info, { dev: Number(info.dev) + 1 });
      return info;
    });
    syncBuiltinESMExports();
    t.after(() => { mockedStat.mock.restore(); syncBuiltinESMExports(); });
    const valid = await retainHistoryThumbnail({ id: "linked-valid", outputDuration: 1 }, undefined, undefined,
      { filePath: linked, start: 4, end: 5, fileSignature: signature });
    assert.equal(valid?.kind, "source");
    assert.equal(await retainHistoryThumbnail({ id: "linked-changed", outputDuration: 1 }, undefined, undefined,
      { filePath: linked, start: 4, end: 5, fileSignature: { ...signature, size: size + 1 } }), undefined);
  });

  await t.test("bad media and cancellation leave no partial image, and opaque IDs cannot escape storage", async () => {
    const bad = path.join(directory, "broken.mp4");
    await writeFile(bad, "not a video");
    assert.equal(await retainHistoryThumbnail({ id: "bad", outputDuration: 1 }, bad), undefined);
    assert.equal(await historyThumbnailExists("bad"), false);
    const controller = new AbortController(); controller.abort();
    assert.equal(await retainHistoryThumbnail({ id: "cancelled", outputDuration: 1 }, source, controller.signal), undefined);
    assert.equal(await retainHistoryThumbnail({ id: "gone", outputDuration: 1 }), undefined);
    const escaped = historyThumbnailPath("../../outside");
    assert.equal(path.dirname(escaped), paths.historyThumbnails);
    assert.match(path.basename(escaped), /^[a-f0-9]{64}\.jpg$/u);
    const symlinked = historyThumbnailPath("not-a-thumbnail");
    await symlink(bad, symlinked);
    assert.equal(await historyThumbnailExists("not-a-thumbnail"), false);
    assert.ok(!(await readdir(paths.historyThumbnails)).some(name => name.endsWith(".tmp.jpg")));
  });
});
