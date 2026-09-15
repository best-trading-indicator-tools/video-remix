import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Transcript } from "../shared/types.js";
import { inspectSourceCaptions } from "../server/source-captions.js";

const exec = promisify(execFile);
const text = ["A faster shutter reduces blur", "Keep the camera still with a tripod", "Check your focus before recording"];
const transcript: Transcript = { language: "en", duration: 12, segments: text.map((text, index) => ({
  start: index * 4, end: index * 4 + 4, text, words: [],
})) };

test("local OCR recognizes moving burned captions without confusing an unchanged logo with speech", { timeout: 150_000 }, async t => {
  try {
    const { stdout } = await exec("tesseract", ["--list-langs"]);
    if (!stdout.split(/\r?\n/u).includes("eng")) { t.skip("Tesseract English language data is not installed"); return; }
  } catch { t.skip("Tesseract is not installed"); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), "source-caption-test-"));
  const previousTemporary = process.env.TMPDIR;
  // Isolate and inspect the detector's temporary work directories without
  // observing concurrent application jobs or other tests' media files.
  process.env.TMPDIR = directory;
  let previousPath: string | undefined;
  try {
    let font = "";
    for (const candidate of ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"])
      try { await access(candidate); font = candidate; break; } catch { /* Try the other supported platform. */ }
    assert.ok(font, "A test caption font must be available");
    const caption = (value: string, start: number, end: number) =>
      `drawtext=fontfile='${font}':text='${value}':fontsize=28:fontcolor=white:x=(w-text_w)/2:y=h-78:enable='gte(t,${start})*lt(t,${end})'`;
    const makeFixture = async (name: string, extra: string[]) => {
      const filePath = path.join(directory, `${name}.mp4`);
      await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
        "-i", "testsrc2=size=640x360:rate=12:duration=12", "-vf",
        ["drawbox=x=0:y=240:w=640:h=120:color=black:t=fill", ...extra].join(","),
        "-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", filePath]);
      return { filePath, size: (await stat(filePath)).size, duration: 12,
        fingerprint: createHash("sha256").update(await readFile(filePath)).digest("hex") };
    };
    const captioned = await makeFixture("captioned", text.map((value, index) => caption(value, index * 4, index * 4 + 4)));
    const clean = await makeFixture("clean", []);
    const logo = await makeFixture("logo", [caption("ACME STUDIO", 0, 12)]);
    const later = await makeFixture("later-captions", text.map((value, index) => caption(value, 6 + index * 2, 8 + index * 2)));
    const cacheDir = path.join(directory, "cache");
    const run = (source: typeof captioned, changes: Partial<Parameters<typeof inspectSourceCaptions>[0]> = {}) => inspectSourceCaptions({
      source, cuts: [{ start: 0, end: 12 }], transcript, signal: new AbortController().signal, cacheDir, ...changes,
    });

    await t.test("changing burned captions match timed speech in actual decoded frames", async () => {
      const result = await run(captioned);
      assert.equal(result.status, "detected", result.reason);
      assert.ok(result.sampledFrames >= 8 && result.sampledFrames <= 12);
      assert.match(result.reason || "", /spoken words/u);
      const files = await readdir(cacheDir);
      assert.equal(files.length, 1);
      const saved = await readFile(path.join(cacheDir, files[0]!), "utf8");
      assert.equal(saved.includes(directory), false, "Cached verdicts contain no source/frame paths");
      assert.equal(saved.includes(text[0]!), false, "OCR/transcript text is not persisted in the cache");
    });
    await t.test("caption-free motion and a static logo are not classified as existing captions", async () => {
      const cleanResult = await run(clean);
      assert.equal(cleanResult.status, "not-detected", cleanResult.reason);
      const logoResult = await run(logo);
      assert.equal(logoResult.status, "not-detected", logoResult.reason);
      assert.match(logoResult.reason || "", /unchanged|isolated/u);
    });
    await t.test("caption-like changes can also be identified without a transcript", async () => {
      const result = await run(captioned, { transcript: undefined });
      assert.equal(result.status, "detected", result.reason);
    });
    await t.test("only selected intervals are inspected; captions elsewhere cannot affect the result", async () => {
      const shifted: Transcript = { ...transcript, segments: transcript.segments.map((segment, index) => ({ ...segment, start: 6 + index * 2, end: 8 + index * 2 })) };
      const early = await run(later, { cuts: [{ start: 0, end: 1.8 }, { start: 3, end: 5.8 }], transcript: shifted });
      assert.equal(early.status, "not-detected", early.reason);
      const late = await run(later, { cuts: [{ start: 6, end: 12 }], transcript: shifted });
      assert.equal(late.status, "detected", late.reason);
      const singlePhrase = await run(captioned, { cuts: [{ start: 0, end: 3 }] });
      assert.equal(singlePhrase.status, "uncertain", "A short selection with matching but unchanged text cannot be declared caption-free");
    });
    await t.test("exact cached results require no OCR executable, while changed cuts require a new inspection", async () => {
      previousPath = process.env.PATH;
      process.env.PATH = path.join(directory, "no-executables");
      try {
        const cached = await run(captioned);
        assert.equal(cached.status, "detected");
        const changed = await run(captioned, { cuts: [{ start: 1, end: 12 }] });
        assert.equal(changed.status, "unavailable");
        const changedLanguage = await run(captioned, { transcript: { ...transcript, language: "zh" } });
        assert.equal(changedLanguage.status, "unavailable");
      } finally {
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        previousPath = undefined;
      }
    });
    await t.test("invalid files and intervals never produce a clean verdict", async () => {
      const invalid = await run(captioned, { cuts: [{ start: 11, end: 14 }] });
      assert.equal(invalid.status, "uncertain"); assert.equal(invalid.sampledFrames, 0);
      const broken = path.join(directory, "broken.mp4"); await writeFile(broken, "not a video");
      const unreadable = await run({ filePath: broken, size: 11, duration: 12, fingerprint: "broken" });
      assert.ok(["unavailable", "uncertain"].includes(unreadable.status));
      const changed = await run({ ...captioned, size: captioned.size + 1 });
      assert.equal(changed.status, "uncertain");
    });
    await t.test("cancellation propagates before and during inspection and removes temporary frames", async () => {
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(run(captioned, { signal: cancelled.signal }), { name: "AbortError" });
      const running = new AbortController();
      const timer = setTimeout(() => running.abort(), 200);
      try {
        await assert.rejects(run(captioned, { signal: running.signal, cacheDir: path.join(directory, "cancel-cache"), cuts: [{ start: 0.3, end: 11.5 }] }), { name: "AbortError" });
      } finally { clearTimeout(timer); }
      assert.equal((await readdir(directory)).some(name => name.startsWith("remix-source-captions-")), false,
        "The detector leaves no sampled frames behind, including after cancellation");
    });
  } finally {
    if (previousTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemporary;
    if (previousPath !== undefined) process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
