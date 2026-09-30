import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { concatFile, prepareConcatSource } from "../server/concat-source.js";
import { probeMedia, renderVideo } from "../server/engine.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

const exec = promisify(execFile);

test("Windows concat paths preserve drive letters, UNC shares, spaces, and apostrophes", () => {
  assert.equal(concatFile("C:\\Videos\\friend's clip.mp4", "win32"), "'file:C:/Videos/friend'\\''s clip.mp4'");
  assert.equal(concatFile("\\\\server\\shared videos\\clip.mp4", "win32"), "'file://server/shared videos/clip.mp4'");
  for (const character of ["\n", "\r", "\0"]) assert.throws(() => concatFile(`C:\\clip${character}file.mp4`, "win32"));
});

test("multi-cut captions and text export without symlink privileges, hard links, or system fonts", { timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "windows-render-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "friend's été video.mp4");
  const output = path.join(directory, "output.mp4");
  const workDir = path.join(directory, "work with spaces");
  const subtitlePath = path.join(directory, "captions.srt");
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", input]);
  await fs.writeFile(subtitlePath, "1\n00:00:00,000 --> 00:00:00,700\nWindows caption\n\n");
  const originalBytes = await fs.readFile(input);
  const alias = path.join(directory, "alias.media");
  assert.deepEqual(await prepareConcatSource(input, alias, "alias.media"), { file: "alias.media", safe: "1", linked: true });
  assert.equal((await fs.stat(alias)).ino, (await fs.stat(input)).ino);
  await fs.rm(alias);

  const originalAccess = fs.access;
  const mocks = [
    t.mock.method(fs, "link", async () => { throw Object.assign(new Error("Different drive"), { code: "EXDEV" }); }),
    t.mock.method(fs, "symlink", async () => { throw Object.assign(new Error("No symlink privilege"), { code: "EPERM" }); }),
    t.mock.method(fs, "access", async (...args: Parameters<typeof fs.access>) => {
      if (typeof args[0] === "string" && (args[0].startsWith("/usr/") || args[0].startsWith("/System/")))
        throw Object.assign(new Error("No system font"), { code: "ENOENT" });
      return originalAccess(...args);
    }),
  ];
  syncBuiltinESMExports();
  t.after(() => { for (const mocked of mocks) mocked.mock.restore(); syncBuiltinESMExports(); });
  await renderVideo({ input, output, workDir, subtitlePath, source: await probeMedia(input),
    settings: { ...DEFAULT_SETTINGS, resolution: "source", aspect: "original",
      segments: [{ start: 0.1, end: 0.5 }, { start: 1, end: 1.4 }], hookText: "Works on Windows", hookDuration: 0.8 },
    onProgress: () => undefined, signal: new AbortController().signal });
  const media = await probeMedia(output);
  assert.ok(Math.abs(media.duration - 0.8) < 0.08);
  assert.equal(media.hasAudio, true);
  assert.deepEqual(await fs.readdir(workDir), [], "Copied fonts and concat files are cleaned up");
  assert.deepEqual(await fs.readFile(input), originalBytes, "The original remains untouched");
});
