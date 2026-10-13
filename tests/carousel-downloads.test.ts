import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import extract from "extract-zip";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createRemixMcpServer } from "../server/mcp/server.js";
import { RemixMcpService } from "../server/mcp/service.js";
import { RemixApi } from "../server/mcp/api.js";
import { DraftStore } from "../server/mcp/drafts.js";
import type { ImportSession } from "../shared/imports.js";
import { socialCarouselLink, parseSocialVideoLinks } from "../shared/social-imports.js";
import { downloadSocialCarousel } from "../server/carousel-downloads.js";
import { proposeDownloadPrompt } from "../server/download-prompt.js";
import type { DownloadDraft } from "../shared/downloads.js";

const instagram = "https://www.instagram.com/p/DeXDaIPFCju/";
const tiktok = "https://www.tiktok.com/@chrissy_dogdiary/photo/7694716604277345544";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("carousel URLs normalize whole posts, remove img_index and tracking, and reject profiles or arbitrary websites", () => {
  assert.equal(socialCarouselLink(`${instagram}?img_index=1&`).url, instagram);
  assert.equal(socialCarouselLink(tiktok).url, tiktok);
  assert.equal(socialCarouselLink("https://m.instagram.com/user/p/DeXDaIPFCju/").url, instagram);
  assert.equal(socialCarouselLink("https://vm.tiktok.com/ABCD?tracking=1").url, "https://vm.tiktok.com/ABCD/");
  const result = parseSocialVideoLinks(`${instagram}?img_index=1&\n${tiktok}\n${instagram}?img_index=4\nhttps://youtube.com/@person`, "carousel");
  assert.deepEqual(result.links, [instagram, tiktok]); assert.equal(result.duplicates, 1); assert.equal(result.invalid.length, 1);
  for (const link of ["http://instagram.com/p/ABC/", "https://instagram.com:123/p/ABC/", "https://user:pw@instagram.com/p/ABC/",
    "https://instagram.com.attacker.test/p/ABC/", "https://instagram.com/user/", "https://tiktok.com/@user", "https://instagram.com/reel/ABC/", "https://localhost/p/ABC/", "https://youtu.be/BaW_jenozKc"])
    assert.throws(() => socialCarouselLink(link), /Instagram post or TikTok/);
});

test("download prompts review bulk URLs, preserve the original draft and reject invented URLs", async t => {
  const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = "test-download-prompt";
  const current: DownloadDraft = { kind: "carousel", links: [instagram, tiktok], stripMetadata: false };
  let response: unknown = { draft: { ...current, links: [tiktok] } }, context: any, instructions = "";
  const mock = t.mock.method(globalThis, "fetch", async (_input, init) => {
    const body = JSON.parse(String(init?.body)); context = JSON.parse(body.messages[1].content); instructions = body.messages[0].content;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(response) } }] });
  });
  try {
    const proposal = await proposeDownloadPrompt("Get only the second carousel", current, new AbortController().signal);
    assert.deepEqual(proposal.draft.links, [tiktok]); assert.deepEqual(current.links, [instagram, tiktok]);
    assert.deepEqual(context.currentDraft, current); assert.match(instructions, /slide order.*ZIP/s); assert.match(proposal.summary.join(" "), /one ZIP per post/);
    response = { draft: current, clarification: "Which post?" };
    assert.deepEqual(await proposeDownloadPrompt("Download that one", current, new AbortController().signal), { draft: current, summary: [], clarification: "Which post?" });
    response = { draft: { ...current, links: ["https://www.instagram.com/p/Invented/"] } };
    await assert.rejects(proposeDownloadPrompt("Get the second post", current, new AbortController().signal), /did not supply/);
    response = { draft: { ...current, links: [instagram], stripMetadata: true } };
    const switched = await proposeDownloadPrompt(`Get carousel images from ${instagram}`, { kind: "video", links: [], stripMetadata: true }, new AbortController().signal);
    assert.equal(switched.draft.kind, "carousel"); assert.equal(switched.draft.stripMetadata, false);
    response = { draft: { ...current, links: ["https://localhost/private"] } };
    await assert.rejects(proposeDownloadPrompt("Download it", current, new AbortController().signal), /invalid download proposal/);
    process.env.DEEPSEEK_API_KEY = "";
    await assert.rejects(proposeDownloadPrompt("Download it", current, new AbortController().signal), /Pasting URLs and downloading stays free/);
  } finally { mock.mock.restore(); if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
});

test("carousel queue, image ZIPs, MCP selection, persistence, failures and cancellation", { timeout: 120_000 }, async t => {
  const root = process.cwd(), directory = await mkdtemp(path.join(os.tmpdir(), "remix-carousel-"));
  const binary = path.join(directory, "gallery-fixture.mjs"), data = path.join(directory, "data");
  const fixture = path.join(root, "tests/fixtures/astronaut.jpg");
  await writeFile(binary, `#!${process.execPath}\n${await readFile(path.join(root, "tests/fixtures/gallery-download.mjs"), "utf8")}`); await chmod(binary, 0o700);
  const environment = { GALLERY_DL_BIN: binary, REMIX_TEST_CAROUSEL_DIR: directory, REMIX_TEST_CAROUSEL_IMAGE: fixture, YT_DLP_COOKIES: "" };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined, log = "";
  const start = async () => {
    server = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "server/index.ts")], {
      cwd: directory, env: { ...process.env, ...environment, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: data, AUTO_AI: "false", DEEPSEEK_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", chunk => { log = (log + chunk).slice(-8000); }); server.stderr?.on("data", chunk => { log = (log + chunk).slice(-8000); });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* Starting. */ } if (server.exitCode !== null) throw new Error(log); await sleep(100); }
    throw new Error(log);
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const current = server;
    await new Promise<void>(resolve => { const timer = setTimeout(() => current.kill("SIGKILL"), 5000); current.once("exit", () => { clearTimeout(timer); resolve(); }); current.kill("SIGTERM"); });
  };
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const get = async (id: string): Promise<ImportSession> => (await fetch(`${base}/api/imports/${id}`)).json();
  const wait = async (id: string, predicate: (item: ImportSession) => boolean) => {
    for (let i = 0; i < 200; i++) { const item = await get(id); if (predicate(item)) return item; await sleep(100); }
    throw new Error(`Timed out: ${JSON.stringify(await get(id))}; ${log}`);
  };
  const unpack = async (url: string) => {
    const response = await fetch(url); assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition")!, /\.zip/);
    const out = await mkdtemp(path.join(directory, "zip-")), zip = path.join(out, "download.zip");
    await writeFile(zip, Buffer.from(await response.arrayBuffer())); await extract(zip, { dir: path.join(out, "contents") });
    return path.join(out, "contents");
  };
  let store: DraftStore | undefined, mcp: ReturnType<typeof createRemixMcpServer> | undefined, client: Client | undefined;
  try {
    await start();
    store = new DraftStore(path.join(directory, "mcp.sqlite")); mcp = createRemixMcpServer(new RemixMcpService(new RemixApi(base), store)); client = new Client({ name: "carousel-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await mcp.connect(serverTransport); await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args }); const content = result.content.find(item => item.type === "text"); assert.ok(content?.type === "text"); assert.ok(!result.isError, content.text); return JSON.parse(content.text);
    };
    let ready: ImportSession[] = [];
    await t.test("MCP downloads both platforms and returns original ordered images with a ZIP per post", async () => {
      const queued = await call("download_carousels", { links: [instagram, tiktok, `${instagram}?img_index=3`] });
      assert.equal(queued.imports.length, 2);
      ready = await Promise.all(queued.imports.map((item: ImportSession) => wait(item.id, entry => entry.status === "completed" || entry.status === "failed")));
      for (const item of ready) {
        assert.equal(item.status, "completed", JSON.stringify(item)); assert.equal(item.downloadKind, "carousel"); assert.equal(item.download?.imageCount, 3); assert.equal(item.stripMetadata, false);
        const contents = await unpack(`${base}${item.download!.url}`); assert.deepEqual((await readdir(contents)).sort(), ["001.jpg", "003.jpg", "010.jpg"]);
        assert.deepEqual(await readFile(path.join(contents, "003.jpg")), await readFile(fixture));
        assert.equal((await fetch(`${base}${item.download!.thumbnailUrl}`)).status, 200);
      }
      assert.equal((await call("list_downloads")).imports.length, 2);
      assert.deepEqual((await (await fetch(`${base}/api/sources`)).json()).sources, []);
      assert.deepEqual((await (await fetch(`${base}/api/imports`)).json()).imports, []);
      assert.deepEqual((await (await fetch(`${base}/api/jobs`)).json()).jobs, []);
    });
    await t.test("selected ZIP contains only selected posts, all-ready groups each post, and restart retains files", async () => {
      const links = await call("get_download_links", { downloadIds: [ready[1]!.id] });
      const selected = await unpack(links.downloadsZip), folders = await readdir(selected);
      assert.equal(folders.length, 1); assert.match(folders[0]!, /tiktok/); assert.equal((await readdir(path.join(selected, folders[0]!))).length, 3);
      const all = await call("get_download_links", { downloadIds: ready.map(item => item.id) });
      assert.equal((await readdir(await unpack(all.downloadsZip))).length, 2);
      await stop(); await start();
      assert.equal((await get(ready[0]!.id)).status, "completed"); await unpack(`${base}${ready[0]!.download!.url}`);
      assert.equal((await fetch(`${base}/api/downloads/selected.zip?ids=${ready[0]!.id},${ready[0]!.id}`)).status, 400);
    });
    await t.test("partial images never become a ready ZIP, retry retains kind, and cancellation deletes working files", async () => {
      const response = await post("/api/downloads", { kind: "carousel", links: ["https://www.instagram.com/p/Missing/", "https://www.instagram.com/p/Retry/", "https://www.instagram.com/p/Slow/", "https://localhost/private"] });
      const batch = await response.json(); assert.equal(response.status, 202); assert.equal(batch.errors.length, 1);
      const [missing, retry, slow] = batch.imports as ImportSession[];
      const failed = await wait(missing!.id, item => item.status === "failed"); assert.match(failed.error!, /Some carousel images/);
      assert.equal((await fetch(`${base}/api/downloads/${failed.id}/file`)).status, 409);
      await wait(retry!.id, item => item.status === "failed"); await call("retry_import", { importId: retry!.id });
      assert.equal((await wait(retry!.id, item => item.status === "completed")).downloadKind, "carousel");
      await wait(slow!.id, item => item.phase.startsWith("Downloading image"));
      await call("cancel_import", { importId: slow!.id });
      assert.equal((await fetch(`${base}/api/imports/${slow!.id}`)).status, 404); await assert.rejects(access(path.join(data, "imports", slow!.id)), { code: "ENOENT" });
      assert.equal((await get(ready[1]!.id)).status, "completed");
    });
    await t.test("an interrupted carousel restarts after shutdown and completed downloads can be removed", async () => {
      const queued = await (await post("/api/downloads", { kind: "carousel", links: ["https://www.instagram.com/p/SlowRestart/"] })).json();
      const id = queued.imports[0].id;
      await wait(id, item => item.phase.startsWith("Downloading image")); await stop(); await start();
      const completed = await wait(id, item => item.status === "completed" || item.status === "failed");
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      const contents = await unpack(`${base}${completed.download!.url}`); assert.equal((await readdir(contents)).length, 3);
      await call("cancel_import", { importId: id });
      assert.equal((await fetch(`${base}/api/downloads/${id}/file`)).status, 404);
      await assert.rejects(access(path.join(data, "imports", id)), { code: "ENOENT" });
    });
    await t.test("downloader rejects unsafe/incomplete output, size limits and login errors without leaking paths", async () => {
      for (const [postId, expected] of [["Empty", /No carousel images/], ["Private", /requires a login/], ["Unsafe", /invalid or duplicate/], ["Duplicate", /invalid or duplicate/], ["Many", /up to 100/], ["Invalid", /unreadable/], ["Symlink", /not downloaded/]] as const) {
        if (postId === "Symlink" && process.platform === "win32") continue;
        const work = await mkdtemp(path.join(directory, "runner-"));
        await assert.rejects(downloadSocialCarousel(`https://www.instagram.com/p/${postId}/`, work, { signal: new AbortController().signal, maxBytes: 10_000_000, checkSpace: async () => {}, onProgress: () => {} }), expected);
      }
      const work = await mkdtemp(path.join(directory, "size-"));
      await assert.rejects(downloadSocialCarousel(instagram, work, { signal: new AbortController().signal, maxBytes: 10, checkSpace: async () => {}, onProgress: () => {} }), /download limit/);
    });
    await t.test("cookies use a disposable copy and Windows JS wrappers run without shell interpolation", async () => {
      const cookies = path.join(directory, "exported cookies.txt"), contents = "# Netscape HTTP Cookie File\n";
      await writeFile(cookies, contents); process.env.YT_DLP_COOKIES = cookies;
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
        const work = await mkdtemp(path.join(directory, "cookies-"));
        const result = await downloadSocialCarousel(instagram, work, { signal: new AbortController().signal, maxBytes: 10_000_000, checkSpace: async () => {}, onProgress: () => {} });
        assert.equal(result.images.length, 3); assert.equal(await readFile(cookies, "utf8"), contents);
        assert.equal((await readdir(work)).some(name => name.startsWith("cookies-")), false);
      } finally { Object.defineProperty(process, "platform", originalPlatform); process.env.YT_DLP_COOKIES = ""; }
    });
  } finally {
    await client?.close(); await mcp?.close(); store?.close(); await stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
