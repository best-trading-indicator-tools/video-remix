import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ImportSession } from "../shared/imports.js";
import { parseSocialVideoLinks, socialVideoLink } from "../shared/social-imports.js";
import { downloadSocialVideo } from "../server/social-imports.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("pasted batches accept mixed platforms and separators, deduplicate video identities, and retain invalid entries", () => {
  const originals = ["https://www.tiktok.com/@creator/video/123456789", "https://www.instagram.com/reel/ABC123/", "https://www.youtube.com/watch?v=BaW_jenozKc"];
  for (const separator of ["\n", "\r\n", " ", "\t", ",", ", ", " ; "])
    assert.deepEqual(parseSocialVideoLinks(originals.join(separator)), { links: originals, invalid: [], duplicates: 0 });
  const parsed = parseSocialVideoLinks([...originals, "https://youtu.be/BaW_jenozKc?si=tracking", "https://instagram.com/reels/ABC123/?igsh=test",
    "https://www.tiktok.com/@creator/video/123456789/?tracking=1", "https://example.com/video", "not-a-link"].join("\n"));
  assert.deepEqual(parsed.links, originals);
  assert.equal(parsed.duplicates, 3);
  assert.deepEqual(parsed.invalid.map(item => item.input), ["https://example.com/video", "not-a-link"]);
  assert.ok(parsed.invalid.every(item => item.error.includes("direct TikTok")));
  assert.deepEqual(parseSocialVideoLinks("\n , ; \t"), { links: [], invalid: [], duplicates: 0 });
  assert.deepEqual(parseSocialVideoLinks(originals[2] + "&tracking=one,two;three").links, [originals[2]]);
  const fullBatch = Array.from({ length: 100 }, (_, index) => `https://www.instagram.com/reel/Batch${index}/`);
  assert.deepEqual(parseSocialVideoLinks(fullBatch.join("\n")).links, fullBatch);
});

test("social links allow individual videos, strip tracking, and reject unrelated URLs", () => {
  assert.deepEqual(socialVideoLink("https://www.youtube.com/shorts/NTlN61zEzUY"), { platform: "YouTube", url: "https://www.youtube.com/watch?v=NTlN61zEzUY" });
  for (const url of ["https://youtu.be/BaW_jenozKc?si=tracking", "https://m.youtube.com/shorts/BaW_jenozKc", "https://youtube.com/watch?v=BaW_jenozKc&list=PL123"])
    assert.deepEqual(socialVideoLink(url), { platform: "YouTube", url: "https://www.youtube.com/watch?v=BaW_jenozKc" });
  assert.equal(socialVideoLink("https://instagram.com/reels/ABC-123_/?igsh=tracking").url, "https://www.instagram.com/reel/ABC-123_/");
  assert.equal(socialVideoLink("https://instagram.com/creator.name/reel/ABC123/").url, "https://www.instagram.com/reel/ABC123/");
  assert.equal(socialVideoLink("https://www.tiktok.com/@creator/video/123456789?is_from_webapp=1").url, "https://www.tiktok.com/@creator/video/123456789");
  for (const url of ["https://vm.tiktok.com/ABC123/", "https://vt.tiktok.com/ABC123/", "https://www.tiktok.com/t/ABC123/"])
    assert.equal(socialVideoLink(url).platform, "TikTok");
  for (const url of ["file:///etc/passwd", "http://localhost/video.mp4", "https://127.0.0.1/", "https://youtube.com.attacker.test/watch?v=BaW_jenozKc",
    "https://youtube.com@attacker.test/watch?v=BaW_jenozKc", "https://user:password@youtube.com/watch?v=BaW_jenozKc", "https://youtube.com:123/watch?v=BaW_jenozKc",
    "https://youtube.com/playlist?list=PL123", "https://youtube.com/@creator", "https://instagram.com/creator/", "https://tiktok.com/@creator/live",
    "https://www.instagram.com/reel/../../../etc/passwd", "ytsearch:cats", "--exec=rm", "https://example.com/video.mp4"])
    assert.throws(() => socialVideoLink(url), /direct TikTok/);
});

test("link imports download into normal sources, recover after restart, and cancel cleanly", { timeout: 120_000 }, async t => {
  const projectDirectory = process.cwd();
  const originalDataDir = process.env.DATA_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-social-imports-"));
  const data = path.join(directory, "data");
  const fixture = path.join(directory, "fixture.mp4");
  const binary = path.join(directory, "yt-dlp-fixture.mjs");
  const argumentsFile = path.join(directory, "arguments.json");
  const retryMarker = path.join(directory, "retried-download");
  const originalCookies = process.env.YT_DLP_COOKIES;
  process.env.YT_DLP_COOKIES = "";
  await writeFile(binary, `#!${process.execPath}
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
await writeFile(${JSON.stringify(argumentsFile)}, JSON.stringify(args));
await writeFile("arguments.json", JSON.stringify(args));
const cookieIndex = args.indexOf("--cookies");
if (cookieIndex >= 0) {
  await writeFile("cookie-input.txt", await readFile(args[cookieIndex + 1]));
  await writeFile(args[cookieIndex + 1], "# Netscape HTTP Cookie File\\n# Updated by downloader\\n");
}
const url = args.at(-1);
if (url.includes("PRIVATE0001")) { console.error("ERROR: Private video; sign in"); process.exit(1); }
if (url.endsWith("/999999999")) { console.error("ERROR: [TikTok] This video is requiring authentication"); process.exit(1); }
if (url.endsWith("/888888888") && cookieIndex < 0) { console.error("ERROR: [TikTok] This video is requiring authentication"); process.exit(1); }
if (url.endsWith("/999999998")) { console.error("ERROR: [TikTok] Unable to extract webpage video data"); process.exit(1); }
if (url.includes("LIMIT000001")) { console.error("ERROR: HTTP Error 429: Too Many Requests"); process.exit(1); }
if (url.includes("RETRY000001")) {
  try { await access(${JSON.stringify(retryMarker)}); }
  catch {
    await writeFile(${JSON.stringify(retryMarker)}, "first attempt failed");
    console.error("ERROR: unable to download video data: HTTP Error 403: Forbidden"); process.exit(1);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
}
if (url.includes("SLOW0000001")) {
  await writeFile("video.mp4.part", "partial download");
  console.error('remix-progress:{"downloaded":20,"total":100}');
  await new Promise(resolve => setTimeout(resolve, 4000));
}
if (url.includes("STAGE000001")) {
  console.log('remix-stage:{invalid');
  console.log('remix-stage:{"stage":"unknown","message":"private-provider-output"}');
  process.stdout.write('remix-st');
  await new Promise(resolve => setTimeout(resolve, 20));
  console.log('age:' + JSON.stringify({ stage: "download", availableAt: "NA", formatsAvailableAt: [Date.now() / 1000 + 1, "NA"] }));
  await new Promise(resolve => setTimeout(resolve, 2400));
}
if (url.includes("SIZES000001")) {
  // Match yt-dlp's output templates, including its bare-NA missing-value behavior.
  const template = args[args.indexOf("--progress-template") + 1].replace(/^download:/, "");
  for (const values of [{ downloaded_bytes: 10, total_bytes: 100 }, { downloaded_bytes: 30, total_bytes_estimate: 100 }, { downloaded_bytes: 50 }]) {
    console.log(template.replace(/%\\(progress\\.(\\w+)(?:\\|([^)]*))?\\)j/g, (_, key, fallback) => values[key] === undefined ? (fallback ?? "NA") : JSON.stringify(values[key])));
  }
}
await copyFile(${JSON.stringify(fixture)}, "video.mp4");
console.log('remix-progress:{"downloaded":100,"total":100}');
if (url.includes("STAGE000001")) console.log('remix-stage:{"stage":"prepare"}');
console.log("remix-result:" + JSON.stringify({ file: path.resolve("video.mp4"), title: "Fixture / title" }));
`);
  await chmod(binary, 0o700);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=1",
    "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-metadata", "title=SOURCE_METADATA_MARKER", "-shortest", fixture]);
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined, log = "";
  const start = async () => {
    server = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(projectDirectory, "server/index.ts")], { cwd: directory,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: data, YT_DLP_BIN: binary,
        AUTO_AI: "false", DEEPSEEK_API_KEY: "", PEXELS_API_KEY: "", PIXABAY_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", chunk => { log = (log + chunk).slice(-10000); });
    server.stderr?.on("data", chunk => { log = (log + chunk).slice(-10000); });
    for (let count = 0; count < 100; count++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* Startup. */ }
      if (server.exitCode !== null) throw new Error(log);
      await sleep(100);
    }
    throw new Error(log);
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const current = server;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => current.kill("SIGKILL"), 10_000);
      current.once("exit", () => { clearTimeout(timer); resolve(); });
      current.kill("SIGTERM");
    });
  };
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const get = async (id: string): Promise<ImportSession> => (await fetch(`${base}/api/imports/${id}`)).json();
  const wait = async (id: string, predicate: (item: ImportSession) => boolean) => {
    for (let count = 0; count < 300; count++) { const item = await get(id); if (predicate(item)) return item; await sleep(100); }
    throw new Error(`Import did not finish: ${JSON.stringify(await get(id))}; ${log}`);
  };
  const add = async (url: string) => {
    const response = await post("/api/imports/links", { links: [url] });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).imports[0] as ImportSession;
  };
  try {
    // Keep automatic cookie discovery away from the developer's real files.
    process.chdir(directory);
    process.env.DATA_DIR = data;
    await start();
    await t.test("rejects unsupported URLs and keeps valid links in a mixed batch", async () => {
      assert.equal((await post("/api/imports/links", { links: ["https://localhost/internal"] })).status, 400);
      assert.equal((await post("/api/imports/links", { links: Array(101).fill("https://youtu.be/BaW_jenozKc") })).status, 400);
      const response = await post("/api/imports/links", { links: ["https://instagram.com/reel/Test123/?igsh=secret", "https://example.com/not-supported"] });
      assert.equal(response.status, 202);
      const batch = await response.json();
      assert.equal(batch.imports.length, 1); assert.equal(batch.errors.length, 1);
      const item = await wait(batch.imports[0].id, value => value.status === "completed" || value.status === "failed");
      assert.equal(item.status, "completed", item.error);
      assert.equal(item.kind, "remote"); assert.equal(item.name, "Fixture  title.mp4");
      assert.ok(item.source!.hasAudio); assert.equal(item.source!.width, 160);
      assert.equal("remoteUrl" in item, false);
      const source = await fetch(`${base}${item.source!.url}`);
      assert.deepEqual(Buffer.from(await source.arrayBuffer()), await readFile(fixture));
      const args: string[] = JSON.parse(await readFile(argumentsFile, "utf8"));
      assert.equal(args.at(-1), "https://www.instagram.com/reel/Test123/");
      for (const flag of ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--max-filesize", "--match-filters", "--js-runtimes"]) assert.ok(args.includes(flag));
      assert.equal(args.includes("--cookies"), false, "Public imports do not require cookies");
      assert.equal(args.includes("--cookies-from-browser"), false);
      assert.deepEqual(await readdir(path.join(data, "imports", item.id)), ["session.json"]);
      await fetch(`${base}/api/imports/${item.id}`, { method: "DELETE" });
      assert.equal((await fetch(`${base}${item.source!.url}`)).status, 200, "Dismissing preserves the imported source");
    });
    await t.test("platform failures explain the local-file fallback without leaking downloader output", async () => {
      const item = await add("https://youtu.be/PRIVATE0001");
      const failed = await wait(item.id, value => value.status === "failed");
      assert.match(failed.error!, /requires a login/);
      assert.match(failed.error!, /Browse files/);
      assert.equal(failed.source, undefined);
      assert.equal(failed.error!.includes(directory), false);
      await assert.rejects(access(path.join(data, "imports", item.id, "download")), { code: "ENOENT" });
    });
    await t.test("a failed link retries in place, clears the error, and creates only one source", async () => {
      const item = await add("https://youtube.com/shorts/RETRY000001");
      const failed = await wait(item.id, value => value.status === "failed");
      assert.match(failed.error!, /temporary.*Retry import/);
      assert.doesNotMatch(failed.error!, /login/);
      const before = (await (await fetch(`${base}/api/imports`)).json()).imports.length;
      const requests = await Promise.all([post(`/api/imports/${item.id}/retry`, {}), post(`/api/imports/${item.id}/retry`, {})]);
      assert.deepEqual(requests.map(response => response.status).sort(), [202, 409]);
      const queued = await requests.find(response => response.status === 202)!.json() as ImportSession;
      assert.equal(queued.id, item.id); assert.equal(queued.status, "processing");
      assert.equal(queued.error, undefined); assert.equal(queued.size, 0); assert.equal(queued.offset, 0);
      assert.ok(queued.updatedAt! > failed.updatedAt!);
      assert.equal("remoteUrl" in queued, false);
      const ready = await wait(item.id, value => ["completed", "failed"].includes(value.status));
      assert.equal(ready.status, "completed", ready.error);
      assert.equal(ready.error, undefined); assert.equal(ready.source?.id, item.id);
      const listed = await (await fetch(`${base}/api/sources`)).json();
      assert.equal(listed.sources.filter((source: { id: string }) => source.id === item.id).length, 1);
      assert.equal((await (await fetch(`${base}/api/imports`)).json()).imports.length, before);
      assert.equal((await post(`/api/imports/${item.id}/retry`, {})).status, 409);
      const saved = JSON.parse(await readFile(path.join(data, "imports", item.id, "session.json"), "utf8"));
      assert.equal(saved.status, "completed"); assert.equal(saved.error, undefined);
      assert.equal(saved.remoteUrl, "https://www.youtube.com/watch?v=RETRY000001");
    });
    await t.test("TikTok authentication and extractor failures have distinct actionable diagnostics", async () => {
      for (const [id, code] of [["999999999", "PLATFORM_LOGIN_REQUIRED"], ["999999998", "PLATFORM_DOWNLOAD_FAILED"]]) {
        const item = await add(`https://www.tiktok.com/@creator/video/${id}`);
        const failed = await wait(item.id, value => value.status === "failed");
        assert.equal(failed.diagnostic?.code, code);
        assert.match(failed.error!, /Browse files/);
        if (code === "PLATFORM_LOGIN_REQUIRED") assert.match(failed.error!, /No cookies were loaded.*YT_DLP_COOKIES/);
        assert.equal(failed.error!.includes(directory), false);
      }
    });
    await t.test("rate limits explain waiting instead of incorrectly claiming a login is required", async () => {
      const item = await add("https://youtu.be/LIMIT000001");
      const failed = await wait(item.id, value => value.status === "failed");
      assert.match(failed.error!, /Wait a few minutes.*Retry import/);
      assert.doesNotMatch(failed.error!, /login/);
    });
    await t.test("one batch imports TikTok, Instagram and YouTube independently while another download fails", async () => {
      const links = ["https://youtu.be/PRIVATE0001", "https://www.tiktok.com/@creator/video/123456789",
        "https://www.instagram.com/reel/Batch123/", "https://youtu.be/BaW_jenozKc"];
      const response = await post("/api/imports/links", { links });
      assert.equal(response.status, 202, await response.clone().text());
      const batch = await response.json() as { imports: ImportSession[]; errors: unknown[] };
      assert.equal(batch.imports.length, 4); assert.deepEqual(batch.errors, []);
      const results = await Promise.all(batch.imports.map(item => wait(item.id, value => ["completed", "failed"].includes(value.status))));
      assert.deepEqual(results.map(item => item.status), ["failed", "completed", "completed", "completed"]);
      assert.equal(new Set(results.slice(1).map(item => item.source?.id)).size, 3);
      for (const item of results.slice(1)) {
        assert.equal(item.progress, 100); assert.equal(item.kind, "remote");
        assert.equal((await fetch(`${base}${item.source!.url}`)).status, 200);
      }
    });
    await t.test("platform wait, download start and MP4 preparation have distinct progress without exposing raw output", async () => {
      const previous = process.env.YT_DLP_BIN;
      const work = await mkdtemp(path.join(directory, "download-stages-"));
      const phases: { phase: string; percent: number }[] = [];
      process.env.YT_DLP_BIN = binary;
      try {
        const result = await downloadSocialVideo("https://youtu.be/STAGE000001", work, {
          signal: new AbortController().signal, maxBytes: 10 * 1024 * 1024,
          onProgress: (phase, percent) => phases.push({ phase, percent }), checkSpace: async () => {},
        });
        assert.ok(result.size > 0);
        assert.deepEqual(phases, [
          { phase: "Waiting for YouTube · 1s", percent: 0 },
          { phase: "Starting download from YouTube", percent: 0 },
          { phase: "Downloading from YouTube", percent: 70 },
          { phase: "Preparing MP4", percent: 70 },
        ]);
        const args: string[] = JSON.parse(await readFile(path.join(work, "arguments.json"), "utf8"));
        assert.ok(args.some(arg => arg.startsWith("before_dl:remix-stage:")));
        assert.ok(args.some(arg => arg.startsWith("post_process:remix-stage:")));
      } finally { if (previous === undefined) delete process.env.YT_DLP_BIN; else process.env.YT_DLP_BIN = previous; }
    });
    await t.test("progress remains readable when yt-dlp omits exact or estimated byte totals", async () => {
      const previous = process.env.YT_DLP_BIN;
      const work = await mkdtemp(path.join(directory, "download-sizes-"));
      const percentages: number[] = [];
      process.env.YT_DLP_BIN = binary;
      try {
        await downloadSocialVideo("https://youtu.be/SIZES000001", work, {
          signal: new AbortController().signal, maxBytes: 10 * 1024 * 1024,
          onProgress: (_, percent) => percentages.push(percent), checkSpace: async () => {},
        });
        assert.deepEqual(percentages, [7, 21, 0, 70]);
      } finally { if (previous === undefined) delete process.env.YT_DLP_BIN; else process.env.YT_DLP_BIN = previous; }
    });
    await t.test("download progress survives polling and pending downloads restart after shutdown", async () => {
      const item = await add("https://youtube.com/watch?v=SLOW0000001");
      await wait(item.id, value => value.phase.startsWith("Downloading") && value.progress > 0);
      await stop(); await start();
      const ready = await wait(item.id, value => value.status === "completed" || value.status === "failed");
      assert.equal(ready.status, "completed", ready.error);
      await stop(); await start();
      assert.equal((await get(item.id)).status, "completed");
    });
    await t.test("cancellation kills downloads and removes partial files", async () => {
      const item = await add("https://youtu.be/SLOW0000001");
      await wait(item.id, value => value.phase.startsWith("Downloading") && value.progress > 0);
      assert.equal((await fetch(`${base}/api/imports/${item.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await fetch(`${base}/api/imports/${item.id}`)).status, 404);
      await assert.rejects(access(path.join(data, "imports", item.id)), { code: "ENOENT" });
      await assert.rejects(access(path.join(data, "uploads", `${item.id}.mp4`)), { code: "ENOENT" });
    });
    await t.test("Windows launches an explicitly configured Node downloader script without a shebang or shell", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const previous = process.env.YT_DLP_BIN;
      const work = await mkdtemp(path.join(directory, "windows-wrapper-"));
      process.env.YT_DLP_BIN = binary;
      try {
        Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
        const result = await downloadSocialVideo("https://youtu.be/BaW_jenozKc", work, {
          signal: new AbortController().signal, maxBytes: 10 * 1024 * 1024,
          onProgress: () => {}, checkSpace: async () => {},
        });
        assert.ok(result.size > 0);
        await access(result.file);
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
        if (previous === undefined) delete process.env.YT_DLP_BIN;
        else process.env.YT_DLP_BIN = previous;
      }
    });
    await t.test("downloaded files are bounded even when size was unavailable before downloading", async () => {
      const previous = process.env.YT_DLP_BIN;
      process.env.YT_DLP_BIN = binary;
      const work = await mkdtemp(path.join(directory, "bounded-"));
      try {
        await assert.rejects(downloadSocialVideo("https://youtu.be/BaW_jenozKc", work, { signal: new AbortController().signal,
          maxBytes: 100, onProgress: () => {}, checkSpace: async () => {} }), /maximum import file size/);
        process.env.YT_DLP_BIN = path.join(directory, "missing-downloader");
        await assert.rejects(downloadSocialVideo("https://youtu.be/BaW_jenozKc", work, { signal: new AbortController().signal,
          maxBytes: 100, onProgress: () => {}, checkSpace: async () => {} }), /npm run setup:imports/);
      } finally { if (previous === undefined) delete process.env.YT_DLP_BIN; else process.env.YT_DLP_BIN = previous; }
    });
    await t.test("configured cookies support Windows paths with spaces and remain unchanged across imports", async () => {
      const previous = process.env.YT_DLP_BIN;
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const cookies = path.join(directory, "my exported cookies.txt");
      const contents = "# Netscape HTTP Cookie File\r\n.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tfixture-only\r\n";
      await writeFile(cookies, contents);
      process.env.YT_DLP_BIN = binary;
      process.env.YT_DLP_COOKIES = path.relative(process.cwd(), cookies);
      const download = (work: string, url = "https://www.tiktok.com/@creator/video/123456789", signal = new AbortController().signal) =>
        downloadSocialVideo(url, work, { signal, maxBytes: 10 * 1024 * 1024, onProgress: () => {}, checkSpace: async () => {} });
      const assertCopyRemoved = async (work: string) => {
        const args: string[] = JSON.parse(await readFile(path.join(work, "arguments.json"), "utf8"));
        const copy = args[args.indexOf("--cookies") + 1]!;
        assert.notEqual(copy, cookies);
        assert.equal(path.dirname(copy), await realpath(work));
        assert.equal(await readFile(path.join(work, "cookie-input.txt"), "utf8"), contents);
        await assert.rejects(access(copy), { code: "ENOENT" });
        return copy;
      };
      try {
        Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
        const works = await Promise.all([1, 2].map(() => mkdtemp(path.join(directory, "cookie-import-"))));
        const results = await Promise.all(works.map(work => download(work)));
        assert.ok(results.every(result => result.size > 0));
        const copies = await Promise.all(works.map(assertCopyRemoved));
        assert.equal(new Set(copies).size, 2, "Concurrent imports use independent cookie jars");
        const failed = await mkdtemp(path.join(directory, "cookie-failed-"));
        await assert.rejects(download(failed, "https://youtu.be/PRIVATE0001"), /requires a login.*Cookies were loaded/);
        await assertCopyRemoved(failed);
        const cancelled = await mkdtemp(path.join(directory, "cookie-cancelled-"));
        const controller = new AbortController();
        await assert.rejects(downloadSocialVideo("https://youtu.be/SLOW0000001", cancelled, {
          signal: controller.signal, maxBytes: 10 * 1024 * 1024,
          onProgress: () => controller.abort(), checkSpace: async () => {},
        }), { name: "AbortError" });
        await assertCopyRemoved(cancelled);
        process.env.YT_DLP_BIN = path.join(directory, "missing-downloader");
        const unstarted = await mkdtemp(path.join(directory, "cookie-unstarted-"));
        await assert.rejects(download(unstarted), /setup:imports/);
        assert.deepEqual(await readdir(unstarted), [], "Failed startup removes its cookie copy too");
        assert.equal(await readFile(cookies, "utf8"), contents, "The exported cookie file is never rewritten");
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
        if (previous === undefined) delete process.env.YT_DLP_BIN; else process.env.YT_DLP_BIN = previous;
        process.env.YT_DLP_COOKIES = "";
      }
    });
    await t.test("existing project and data cookie files authenticate imports without an env setting", async () => {
      const previous = process.env.YT_DLP_BIN;
      const customData = path.join(directory, "custom data");
      await mkdir(customData);
      const projectCookies = path.join(directory, "cookies.txt");
      const dataCookies = path.join(customData, "cookies.txt");
      const explicitCookies = path.join(directory, "explicit-cookies.txt");
      const contents = (label: string) => `# Netscape HTTP Cookie File\r\n# ${label}\r\n`;
      process.env.YT_DLP_BIN = binary;
      process.env.DATA_DIR = customData;
      delete process.env.YT_DLP_COOKIES;
      const download = (work: string) => downloadSocialVideo("https://www.tiktok.com/@creator/video/888888888", work, {
        signal: new AbortController().signal, maxBytes: 10 * 1024 * 1024, onProgress: () => {}, checkSpace: async () => {},
      });
      const check = async (expected: string) => {
        const work = await mkdtemp(path.join(directory, "discovered-cookies-"));
        assert.ok((await download(work)).size > 0);
        assert.equal(await readFile(path.join(work, "cookie-input.txt"), "utf8"), contents(expected));
        const args: string[] = JSON.parse(await readFile(path.join(work, "arguments.json"), "utf8"));
        await assert.rejects(access(args[args.indexOf("--cookies") + 1]!), { code: "ENOENT" });
      };
      try {
        const work = await mkdtemp(path.join(directory, "anonymous-import-"));
        await assert.rejects(download(work), /No cookies were loaded/);
        await writeFile(dataCookies, contents("data"));
        await check("data");
        await writeFile(projectCookies, contents("project"));
        await check("project");
        await writeFile(explicitCookies, contents("explicit"));
        process.env.YT_DLP_COOKIES = explicitCookies;
        await check("explicit");
        process.env.YT_DLP_COOKIES = path.join(directory, "missing-cookies.txt");
        await assert.rejects(download(work), /configured download cookies/, "An invalid explicit setting cannot silently use a different account");
        process.env.YT_DLP_COOKIES = "";
        await writeFile(projectCookies, "not a cookie export");
        await assert.rejects(download(work), /Netscape-format/, "Invalid discovered cookies are explained rather than ignored");
        assert.equal(await readFile(dataCookies, "utf8"), contents("data"));
        assert.equal(await readFile(explicitCookies, "utf8"), contents("explicit"));
      } finally {
        await rm(projectCookies, { force: true });
        process.env.DATA_DIR = data;
        process.env.YT_DLP_COOKIES = "";
        if (previous === undefined) delete process.env.YT_DLP_BIN; else process.env.YT_DLP_BIN = previous;
      }
    });
    await t.test("standalone bulk downloads clean metadata, serve MP4 and ZIP, and leave the importer and exports separate", async () => {
      const originalSources = (await (await fetch(`${base}/api/sources`)).json()).sources.map((item: any) => item.id);
      const originalImports = (await (await fetch(`${base}/api/imports`)).json()).imports.map((item: any) => item.id);
      const result = await post("/api/downloads", { links: ["https://www.youtube.com/shorts/NTlN61zEzUY", "https://youtu.be/NTlN61zEzUY", "https://www.instagram.com/reel/Download123/", "https://localhost/private"] });
      assert.equal(result.status, 202);
      const queued = await result.json() as { imports: ImportSession[]; errors: { error: string }[] };
      assert.equal(queued.imports.length, 2); assert.equal(queued.errors.length, 1);
      assert.ok(queued.imports.every(item => item.purpose === "download" && item.stripMetadata));
      const ready = await Promise.all(queued.imports.map(item => wait(item.id, value => ["completed", "failed"].includes(value.status))));
      for (const item of ready) {
        assert.equal(item.status, "completed", JSON.stringify(item)); assert.equal(item.source, undefined); assert.ok(item.download);
        const response = await fetch(`${base}${item.download.url}`);
        assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /attachment.*\.mp4/);
        const file = path.join(directory, `${item.id}.mp4`);
        await writeFile(file, Buffer.from(await response.arrayBuffer()));
        const metadata = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-show_chapters", "-of", "json", file])).stdout);
        assert.equal(metadata.format.tags.title, undefined); assert.equal(metadata.format.tags.encoder, undefined);
        assert.equal(metadata.chapters.length, 0); assert.equal(item.download.width, 160); assert.equal(item.download.height, 90);
        assert.equal((await fetch(`${base}${item.download.thumbnailUrl}`)).status, 200);
      }
      const zip = await fetch(`${base}/api/downloads/selected.zip?ids=${ready.map(item => item.id).join(",")}`);
      assert.equal(zip.status, 200); const zipFile = path.join(directory, "downloads.zip");
      await writeFile(zipFile, Buffer.from(await zip.arrayBuffer()));
      assert.match((await exec("unzip", ["-t", zipFile])).stdout, /No errors/);
      const names = (await exec("unzip", ["-Z1", zipFile])).stdout.trim().split("\n");
      assert.equal(names.length, 2); assert.ok(names.every(name => name.endsWith(".mp4"))); assert.notEqual(names[0], names[1]);
      assert.equal((await fetch(`${base}/api/downloads/selected.zip?ids=${ready[0]!.id},invalid`)).status, 400);
      assert.equal((await fetch(`${base}/api/downloads/selected.zip?ids=${ready[0]!.id},${ready[0]!.id}`)).status, 400);
      assert.deepEqual((await (await fetch(`${base}/api/sources`)).json()).sources.map((item: any) => item.id), originalSources);
      assert.deepEqual((await (await fetch(`${base}/api/imports`)).json()).imports.map((item: any) => item.id), originalImports);
      assert.equal((await (await fetch(`${base}/api/jobs`)).json()).jobs.length, 0);
      await stop(); await start();
      assert.equal((await (await fetch(`${base}/api/downloads`)).json()).imports.length, 2);
      assert.equal((await fetch(`${base}${ready[0]!.download!.url}`)).status, 200);
      const original = await (await post("/api/downloads", { links: ["https://youtu.be/BaW_jenozKc"], stripMetadata: false })).json();
      const retained = await wait(original.imports[0].id, item => item.status === "completed");
      assert.deepEqual(Buffer.from(await (await fetch(`${base}${retained.download!.url}`)).arrayBuffer()), await readFile(fixture));
      for (const item of [...ready, retained]) {
        assert.equal((await fetch(`${base}/api/imports/${item.id}`, { method: "DELETE" })).status, 200);
        assert.equal((await fetch(`${base}/api/downloads/${item.id}/file`)).status, 404);
        await assert.rejects(access(path.join(data, "imports", item.id)), { code: "ENOENT" });
      }
    });
    await t.test("standalone failures can retry and active downloads can cancel without affecting other files", async () => {
      await rm(retryMarker, { force: true });
      const response = await post("/api/downloads", { links: ["https://youtu.be/RETRY000001", "https://youtu.be/SLOW0000001"] });
      const [retry, slow] = (await response.json()).imports as ImportSession[];
      const failed = await wait(retry!.id, item => item.status === "failed");
      assert.equal((await fetch(`${base}/api/downloads/${failed.id}/file`)).status, 409);
      assert.equal((await fetch(`${base}/api/downloads/selected.zip?ids=${failed.id}`)).status, 409);
      assert.equal((await fetch(`${base}/api/imports/${slow!.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await post(`/api/imports/${failed.id}/retry`, {})).status, 202);
      const recovered = await wait(failed.id, item => ["completed", "failed"].includes(item.status));
      assert.equal(recovered.status, "completed", JSON.stringify(recovered)); assert.equal(recovered.stripMetadata, true);
      await fetch(`${base}/api/imports/${recovered.id}`, { method: "DELETE" });
    });
    await t.test("invalid configured cookies fail clearly without falling back to anonymous downloads", async () => {
      const malformed = path.join(directory, "invalid-cookies.txt");
      await writeFile(malformed, "[]");
      const work = await mkdtemp(path.join(directory, "invalid-cookies-"));
      try {
        for (const candidate of [path.join(directory, "missing-cookies.txt"), directory, malformed]) {
          process.env.YT_DLP_COOKIES = candidate;
          await assert.rejects(downloadSocialVideo("https://youtu.be/BaW_jenozKc", work, {
            signal: new AbortController().signal, maxBytes: 100, onProgress: () => {}, checkSpace: async () => {},
          }), error => {
            assert.match((error as Error).message, /configured download cookies/);
            assert.equal((error as Error).message.includes(candidate), false);
            return true;
          });
          assert.deepEqual(await readdir(work), []);
        }
      } finally { process.env.YT_DLP_COOKIES = ""; }
    });
  } finally {
    process.chdir(projectDirectory);
    if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
    if (originalCookies === undefined) delete process.env.YT_DLP_COOKIES; else process.env.YT_DLP_COOKIES = originalCookies;
    await stop(); await rm(directory, { recursive: true, force: true });
  }
});
