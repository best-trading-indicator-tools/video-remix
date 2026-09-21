import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ImportSession } from "../shared/imports.js";
import { socialVideoLink } from "../shared/social-imports.js";
import { downloadSocialVideo } from "../server/social-imports.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("social links allow individual videos, strip tracking, and reject unrelated URLs", () => {
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-social-imports-"));
  const data = path.join(directory, "data");
  const fixture = path.join(directory, "fixture.mp4");
  const binary = path.join(directory, "yt-dlp-fixture.mjs");
  const argumentsFile = path.join(directory, "arguments.json");
  await writeFile(binary, `#!${process.execPath}
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
await writeFile(${JSON.stringify(argumentsFile)}, JSON.stringify(args));
const url = args.at(-1);
if (url.includes("PRIVATE0001")) { console.error("ERROR: Private video; sign in"); process.exit(1); }
if (url.includes("SLOW0000001")) {
  await writeFile("video.mp4.part", "partial download");
  console.error('remix-progress:{"downloaded":20,"total":100}');
  await new Promise(resolve => setTimeout(resolve, 4000));
}
await copyFile(${JSON.stringify(fixture)}, "video.mp4");
console.log('remix-progress:{"downloaded":100,"total":100}');
console.log("remix-result:" + JSON.stringify({ file: path.resolve("video.mp4"), title: "Fixture / title" }));
`);
  await chmod(binary, 0o700);
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=12:duration=1",
    "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture]);
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined, log = "";
  const start = async () => {
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(),
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
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
