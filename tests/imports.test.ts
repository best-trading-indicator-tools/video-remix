import { readWorkspaceFile, writeWorkspaceFile, failWorkspaceWrites } from "./helpers/workspace.js";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ImportSession } from "../shared/imports.js";
import { DEFAULT_SETTINGS, type RenderJob } from "../shared/types.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test("large imports resume durably, protect originals, and handle 40GiB without copying it", { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-imports-"));
  const data = path.join(directory, "data");
  const base = `http://127.0.0.1:${await unusedPort()}`;
  let server: ChildProcess | undefined;
  let log = "";
  const start = async () => {
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(), env: { ...process.env, PORT: new URL(base).port, HOST: "127.0.0.1", DATA_DIR: data,
        MAX_FILE_SIZE_MB: "2", MAX_LARGE_FILE_SIZE_GB: "50", RETENTION_HOURS: "1", RENDER_CONCURRENCY: "1",
        AUTO_AI: "false", DEEPSEEK_API_KEY: "", PEXELS_API_KEY: "", PIXABAY_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", chunk => { log = (log + chunk).slice(-20000); });
    server.stderr?.on("data", chunk => { log = (log + chunk).slice(-20000); });
    for (let index = 0; index < 100; index++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* Starting */ }
      if (server.exitCode !== null) throw new Error(log);
      await sleep(100);
    }
    throw new Error(`Server failed to start: ${log}`);
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
  const json = (url: string, body: unknown) => fetch(`${base}${url}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const getImport = async (id: string): Promise<ImportSession> => {
    const response = await fetch(`${base}/api/imports/${id}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const waitImport = async (id: string, status = "completed", timeout = 90_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const item = await getImport(id);
      if (item.status === status) return item;
      if (item.status === "failed" && status !== "failed") throw new Error(`${item.error}; ${log}`);
      await sleep(80);
    }
    throw new Error(`Import ${id} timed out: ${log}`);
  };
  const chunk = (id: string, offset: number, bytes: Uint8Array) => fetch(`${base}/api/imports/${id}`, {
    method: "PUT", headers: { "Content-Type": "application/octet-stream", "Upload-Offset": String(offset) }, body: bytes as BodyInit,
  });
  const dismiss = (id: string) => fetch(`${base}/api/imports/${id}`, { method: "DELETE" });
  try {
    const fixture = path.join(directory, "fixture.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3", "-c:v", "libx264", "-threads", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", fixture]);
    const bytes = await readFile(fixture);
    const identity = createHash("sha256").update(bytes).digest("hex");
    await start();
    await t.test("limits are separate, metadata validation is strict, and upload offsets survive restart", async () => {
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.maxFileSize, 2 * 1024 ** 2);
      assert.equal(health.maxLargeFileSize, 50 * 1024 ** 3);
      assert.equal(health.importChunkSize, 8 * 1024 ** 2);
      assert.equal((await json("/api/imports", { name: "bad.exe", size: 100, lastModified: 1, identity })).status, 400);
      assert.equal((await json("/api/imports", { name: "bad.mp4", size: 51 * 1024 ** 3, lastModified: 1, identity })).status, 400);
      assert.equal((await json("/api/imports", { name: "bad.mp4", size: 100, lastModified: 1, identity: "bad" })).status, 400);
      const started = await json("/api/imports", { name: "été original.mp4", size: bytes.length, lastModified: 123, identity });
      assert.equal(started.status, 201, await started.clone().text());
      const item = await started.json() as ImportSession;
      assert.equal(item.offset, 0);
      assert.equal((await chunk(item.id, 1, bytes.subarray(0, 20))).status, 409);
      assert.equal((await json(`/api/imports/${item.id}/finish`, {})).status, 409);
      assert.equal((await chunk(item.id, 0, new Uint8Array(bytes.length + 1))).status, 400);
      const half = Math.floor(bytes.length / 2);
      assert.equal((await chunk(item.id, 0, bytes.subarray(0, half))).status, 200);
      await stop();
      const managed = path.join(data, "uploads", `${item.id}.mp4`);
      const handle = await open(managed, "a");
      await handle.write(Buffer.from("uncommitted bytes after a crash")); await handle.close();
      await start();
      assert.equal((await stat(managed)).size, half, "Startup truncates bytes not committed in session metadata");
      assert.equal((await getImport(item.id)).offset, half);
      assert.equal((await chunk(item.id, 0, bytes.subarray(0, 10))).status, 409);
      assert.equal((await chunk(item.id, half, bytes.subarray(half))).status, 200);
      const finished = await json(`/api/imports/${item.id}/finish`, {});
      assert.equal(finished.status, 202);
      const ready = await waitImport(item.id);
      assert.equal(ready.source!.fingerprint, identity);
      assert.equal(ready.source!.name, "été original.mp4");
      assert.equal("filePath" in ready.source!, false);
      assert.equal("fileSignature" in ready.source!, false);
      assert.equal((await json(`/api/imports/${item.id}/finish`, {})).status, 200);
      assert.equal((await dismiss(item.id)).status, 200);
      assert.equal((await fetch(`${base}${ready.source!.url}`)).status, 200, "Dismissing a completed session preserves its source");
    });
    await t.test("an interrupted request leaves no committed bytes and cancellation removes temporary files", async () => {
      const item = await (await json("/api/imports", { name: "interrupted.mp4", size: bytes.length, lastModified: 1, identity })).json() as ImportSession;
      await new Promise<void>(resolve => {
        const request = http.request(`${base}/api/imports/${item.id}`, { method: "PUT", headers: {
          "Content-Type": "application/octet-stream", "Upload-Offset": "0", "Content-Length": String(bytes.length),
        } });
        request.on("error", () => resolve());
        request.write(bytes.subarray(0, 1000));
        setTimeout(() => request.destroy(), 30);
      });
      await sleep(80);
      assert.equal((await getImport(item.id)).offset, 0);
      assert.equal((await stat(path.join(data, "uploads", `${item.id}.mp4`))).size, 0);
      assert.equal((await dismiss(item.id)).status, 200);
      await assert.rejects(access(path.join(data, "uploads", `${item.id}.mp4`)), { code: "ENOENT" });
      await assert.rejects(access(path.join(data, "imports", item.id)), { code: "ENOENT" });
      assert.equal((await fetch(`${base}/api/imports/${item.id}`)).status, 404);
    });
    await t.test("each chunk acknowledgement immediately permits the next chunk and finishing", async () => {
      const item = await (await json("/api/imports", { name: "fast sequential.mp4", size: bytes.length, lastModified: 1, identity })).json() as ImportSession;
      const length = Math.ceil(bytes.length / 40);
      for (let offset = 0; offset < bytes.length; offset += length) {
        const response = await chunk(item.id, offset, bytes.subarray(offset, Math.min(bytes.length, offset + length)));
        assert.equal(response.status, 200, await response.clone().text());
        const confirmed = await response.json();
        assert.equal(confirmed.offset, Math.min(bytes.length, offset + length));
      }
      const finished = await json(`/api/imports/${item.id}/finish`, {});
      assert.equal(finished.status, 202, await finished.clone().text());
      assert.equal((await waitImport(item.id)).source!.fingerprint, identity);
      await dismiss(item.id);
    });
    await t.test("concurrent finish requests are idempotent and failed workspace commits remain retryable", async () => {
      const item = await (await json("/api/imports", { name: "concurrent.mp4", size: bytes.length, lastModified: 1, identity })).json() as ImportSession;
      assert.equal((await chunk(item.id, 0, bytes)).status, 200);
      const finishes = await Promise.all(Array.from({ length: 8 }, () => json(`/api/imports/${item.id}/finish`, {})));
      assert.ok(finishes.every(response => response.status === 202 || response.status === 200));
      const ready = await waitImport(item.id);
      const sources = (await (await fetch(`${base}/api/sources`)).json()).sources;
      assert.equal(sources.filter((source: { id: string }) => source.id === item.id).length, 1);
      assert.equal(ready.status, "completed");
      await dismiss(item.id);

      const broken = await (await json("/api/imports", { name: "retryable.mp4", size: bytes.length, lastModified: 1, identity })).json() as ImportSession;
      assert.equal((await chunk(broken.id, 0, bytes)).status, 200);
      await failWorkspaceWrites(data, true);
      try {
        assert.equal((await json(`/api/imports/${broken.id}/finish`, {})).status, 202);
        assert.equal((await waitImport(broken.id, "failed")).source, undefined);
        const after = (await (await fetch(`${base}/api/sources`)).json()).sources;
        assert.equal(after.some((source: { id: string }) => source.id === broken.id), false);
      } finally { await failWorkspaceWrites(data, false); }
      await stop(); await start();
      assert.equal((await getImport(broken.id)).status, "failed");
      assert.equal((await json(`/api/imports/${broken.id}/finish`, {})).status, 202);
      assert.equal((await waitImport(broken.id)).source!.fingerprint, identity);
      await dismiss(broken.id);
    });
    await t.test("linked files render, expose no paths, detect changes, and survive workspace removal", async () => {
      const original = path.join(directory, "my linked original.mp4");
      await copyFile(fixture, original);
      const response = await json("/api/imports/local", { paths: [original, path.join(directory, "missing.mp4"), directory] });
      assert.equal(response.status, 202);
      const result = await response.json();
      assert.equal(result.imports.length, 1); assert.equal(result.errors.length, 2);
      assert.equal(JSON.stringify(result).includes(directory), false);
      const ready = await waitImport(result.imports[0].id);
      const managed = path.join(data, "uploads", `${ready.id}.mp4`);
      assert.equal((await lstat(managed)).isSymbolicLink(), true);
      assert.equal((await stat(managed)).ino, (await stat(original)).ino);
      const ranged = await fetch(`${base}${ready.source!.url}`, { headers: { Range: "bytes=0-31" } });
      assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 32);
      const settings = { ...DEFAULT_SETTINGS, trimEnd: 0.5 };
      const preview = await json("/api/previews", { sourceId: ready.id, settings });
      assert.equal(preview.status, 201, await preview.clone().text());
      const before = await stat(original);
      await utimes(original, before.atime, new Date(before.mtimeMs + 5000));
      const changed = await fetch(`${base}${ready.source!.url}`);
      assert.equal(changed.status, 409); assert.equal((await changed.text()).includes(directory), false);
      assert.equal((await json("/api/previews", { sourceId: ready.id, settings })).status, 409);
      const jobResponse = await json("/api/jobs", { items: [{ sourceId: ready.id, settings }] });
      assert.equal(jobResponse.status, 201);
      const id = (await jobResponse.json()).jobs[0].id;
      let job: RenderJob | undefined;
      for (let index = 0; index < 100; index++) {
        job = (await (await fetch(`${base}/api/jobs`)).json()).jobs.find((value: RenderJob) => value.id === id);
        if (job?.status === "failed") break;
        await sleep(50);
      }
      assert.equal(job?.status, "failed"); assert.match(job?.error || "", /linked original.*changed/iu);
      assert.equal((await fetch(`${base}/api/sources/${ready.id}`, { method: "DELETE" })).status, 200);
      await access(original);
      await assert.rejects(access(managed), { code: "ENOENT" });
      assert.equal((await getImport(ready.id)).source, undefined, "A deleted source must never reappear through completed import polling");
      assert.equal((await dismiss(ready.id)).status, 200);
      await access(original);
    });
    await t.test("a resumed chunk uses exact offsets above 4GiB and processes valid sparse MP4 content", async () => {
      await stop();
      const id = randomUUID();
      const size = 4 * 1024 ** 3 + 4096;
      const offset = size - 64;
      const managed = path.join(data, "uploads", `${id}.mp4`);
      await copyFile(fixture, managed);
      const handle = await open(managed, "r+");
      const free = Buffer.alloc(16); free.writeUInt32BE(1, 0); free.write("free", 4); free.writeBigUInt64BE(BigInt(size - bytes.length), 8);
      await handle.write(free, 0, free.length, bytes.length); await handle.truncate(offset + 32); await handle.close();
      await mkdir(path.join(data, "imports", id), { recursive: true });
      const now = Date.now();
      await writeFile(path.join(data, "imports", id, "session.json"), JSON.stringify({
        id, name: "sparse.mp4", size, offset, kind: "upload", status: "uploading", phase: "Uploading video", progress: 0,
        createdAt: now, updatedAt: now, identity, lastModified: 1,
      }));
      await start();
      assert.equal((await stat(managed)).size, offset);
      assert.equal((await getImport(id)).offset, offset);
      const response = await chunk(id, offset, new Uint8Array(64));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).offset, size);
      assert.equal((await json(`/api/imports/${id}/finish`, {})).status, 202);
      const ready = await waitImport(id);
      assert.equal(ready.source!.size, size);
      assert.equal(ready.source!.width, 320);
      const tail = await fetch(`${base}${ready.source!.url}`, { headers: { Range: `bytes=${size - 16}-${size - 1}` } });
      assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 16);
      assert.equal((await fetch(`${base}/api/sources/${id}`, { method: "DELETE" })).status, 200);
      await dismiss(id);
    });
    await t.test("recovery and failed-session retries never truncate an upload replaced by a symlink", async () => {
      const original = path.join(directory, "never truncate this.mp4");
      await copyFile(fixture, original);
      const item = await (await json("/api/imports", { name: "substituted.mp4", size: bytes.length, lastModified: 1, identity })).json() as ImportSession;
      assert.equal((await chunk(item.id, 0, bytes)).status, 200);
      await stop();
      const managed = path.join(data, "uploads", `${item.id}.mp4`);
      await rm(managed); await symlink(original, managed);
      await start();
      assert.equal((await getImport(item.id)).status, "failed");
      assert.deepEqual(await readFile(original), bytes);
      assert.equal((await json(`/api/imports/${item.id}/finish`, {})).status, 202);
      assert.equal((await waitImport(item.id, "failed")).source, undefined);
      assert.deepEqual(await readFile(original), bytes);
      await dismiss(item.id);
      assert.deepEqual(await readFile(original), bytes);
    });
    await t.test("40GiB local import remains sparse, completes fingerprinting, and retention keeps the original", async () => {
      const original = path.join(directory, "40 GiB original.mp4");
      const size = 40 * 1024 ** 3;
      await copyFile(fixture, original);
      const handle = await open(original, "r+");
      const free = Buffer.alloc(16); free.writeUInt32BE(1, 0); free.write("free", 4); free.writeBigUInt64BE(BigInt(size - bytes.length), 8);
      await handle.write(free, 0, free.length, bytes.length); await handle.truncate(size); await handle.close();
      const sparseInfo = await stat(original);
      assert.ok(sparseInfo.blocks * 512 < 2 * 1024 ** 2, "The test must not allocate40GiB of disk storage");
      const response = await json("/api/imports/local", { paths: [original] });
      assert.equal(response.status, 202, await response.clone().text());
      const pending = (await response.json()).imports[0] as ImportSession;
      await stop();
      await start();
      const ready = await waitImport(pending.id, "completed", 120_000);
      assert.equal(ready.size, size); assert.equal(ready.source!.size, size);
      assert.equal(ready.source!.fingerprint?.length, 64);
      const managed = path.join(data, "uploads", `${ready.id}.mp4`);
      assert.equal((await lstat(managed)).isSymbolicLink(), true);
      assert.equal((await stat(original)).blocks, sparseInfo.blocks);
      await stop();
      const statePath = path.join(data, "state.json");
      const saved = JSON.parse(await readWorkspaceFile(statePath, "utf8"));
      saved.sources.find((source: { id: string }) => source.id === ready.id).createdAt = "2000-01-01T00:00:00.000Z";
      await writeWorkspaceFile(statePath, JSON.stringify(saved));
      await start();
      await access(original);
      await assert.rejects(access(managed), { code: "ENOENT" });
      assert.equal((await getImport(ready.id)).source, undefined);
      assert.equal((await stat(original)).size, size);
      await dismiss(ready.id);
    });
    await t.test("invalid media fails safely and expired upload sessions reclaim their owned files", async () => {
      const item = await (await json("/api/imports", { name: "broken.mp4", size: 5, lastModified: 1, identity })).json() as ImportSession;
      assert.equal((await chunk(item.id, 0, new Uint8Array([1, 2, 3, 4, 5]))).status, 200);
      assert.equal((await json(`/api/imports/${item.id}/finish`, {})).status, 202);
      const failed = await waitImport(item.id, "failed");
      assert.equal(failed.error?.includes(directory), false);
      await stop();
      const sessionPath = path.join(data, "imports", item.id, "session.json");
      const saved = JSON.parse(await readFile(sessionPath, "utf8"));
      saved.updatedAt = 0; await writeFile(sessionPath, JSON.stringify(saved));
      await start();
      assert.equal((await fetch(`${base}/api/imports/${item.id}`)).status, 404);
      await assert.rejects(access(path.join(data, "uploads", `${item.id}.mp4`)), { code: "ENOENT" });
      assert.ok((await readdir(path.join(data, "imports"))).every(name => name !== item.id));
    });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
