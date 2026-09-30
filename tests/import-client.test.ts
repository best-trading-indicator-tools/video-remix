import { ApiError } from "../src/api-client.js";
import { clearDiagnostics, getDiagnostics } from "../src/diagnostics-store.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createUploadImport, importVideoLinks, uploadIdentity, transferImport } from "../src/import-client.js";
import type { ImportSession } from "../shared/imports.js";

const videoLinks = ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"];
const linkTimeout = /timed out after 30 seconds.*server.*may already be queued.*check the import queue/u;

test("link submission aborts an unresponsive server after 30 seconds without retrying", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal;
  const fetch = t.mock.method(globalThis, "fetch", (_input, init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const request = importVideoLinks(videoLinks);
  const rejected = assert.rejects(request, linkTimeout);
  t.mock.timers.tick(29_999);
  assert.equal(signal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal!.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test("link submission also times out when headers arrive but the response body stalls", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_input, init: RequestInit) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"imports":'));
      init.signal!.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), { once: true });
    },
  }), { status: 202 }));
  const request = importVideoLinks(videoLinks);
  const rejected = assert.rejects(request, linkTimeout);
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await rejected;
});

test("accepted links return their queue result and clear the submission deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queued = { imports: [{ id: "queued", status: "processing" }], errors: [] };
  let signal: AbortSignal;
  t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    assert.equal(url, "/api/imports/links");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body as string), { links: videoLinks });
    signal = init.signal!;
    return Response.json(queued, { status: 202 });
  });
  assert.deepEqual(await importVideoLinks(videoLinks), queued);
  t.mock.timers.tick(30_000);
  assert.equal(signal!.aborted, false);
});

test("link submission preserves server and network errors and clears their deadlines", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal;
  let offline = false;
  t.mock.method(globalThis, "fetch", async (_input, init: RequestInit) => {
    signal = init.signal!;
    if (offline) throw new TypeError("Failed to fetch");
    return Response.json({ error: "There is not enough free disk space." }, { status: 507 });
  });
  await assert.rejects(importVideoLinks(videoLinks), /not enough free disk space/u);
  t.mock.timers.tick(30_000);
  assert.equal(signal!.aborted, false);
  offline = true;
  await assert.rejects(importVideoLinks(videoLinks), /Could not connect to the video engine/u);
  t.mock.timers.tick(30_000);
  assert.equal(signal!.aborted, false);
});

test("resume identity reads bounded edge samples, including a video larger than 4 GiB", async () => {
  const calls: [number, number | undefined][] = [];
  const large = 40 * 1024 ** 3;
  const file = { size: large, slice(start: number, end?: number) {
    calls.push([start, end]);
    return new Blob([new Uint8Array((end ?? large) - start).fill(start === 0 ? 1 : 2)]);
  } } as File;
  const identity = await uploadIdentity(file);
  assert.deepEqual(calls, [[0, 65536], [large - 65536, undefined]]);
  const expected = createHash("sha256").update(new Uint8Array(65536).fill(1)).update(new Uint8Array(65536).fill(2)).digest("hex");
  assert.equal(identity, expected);
  const tiny = new File(["short video sample"], "clip.mp4");
  assert.equal(await uploadIdentity(tiny), createHash("sha256").update("short video sample").digest("hex"));
});

test("a 40 GiB import resumes at the confirmed offset and reconciles a lost chunk response", async () => {
  const originalFetch = globalThis.fetch;
  const large = 40 * 1024 ** 3;
  const slices: [number, number][] = [];
  const file = { size: large, slice(start: number, end: number) {
    slices.push([start, end]);
    return new Blob([new Uint8Array(end - start)]);
  } } as File;
  let state: ImportSession = { id: "test", name: "large.mp4", kind: "upload", size: large,
    offset: large - 12, chunkSize: 8, status: "uploading", phase: "Uploading", progress: 0 };
  const offsets: number[] = [];
  let loseResponse = true;
  let finishCalls = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PUT") {
      assert.equal(Number((init.headers as Record<string, string>)["Upload-Offset"]), state.offset);
      const body = init.body as Blob;
      assert.ok(body.size <= 8);
      state = { ...state, offset: state.offset + body.size };
      if (loseResponse) { loseResponse = false; throw new TypeError("Connection lost after commit"); }
    } else if (init?.method === "POST") {
      finishCalls++;
      assert.equal(state.offset, large);
      state = { ...state, status: "processing" };
    }
    return Response.json(state);
  };
  try {
    const result = await transferImport(file, state, new AbortController().signal, value => offsets.push(value.offset));
    assert.deepEqual(slices, [[large - 12, large - 4], [large - 4, large]]);
    assert.deepEqual(offsets, [large - 4, large]);
    assert.equal(result.status, "processing");
    assert.equal(finishCalls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("paused transfers stop without submitting a finish request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  const state: ImportSession = { id: "pause", name: "clip.mp4", kind: "upload", size: 10, offset: 0,
    chunkSize: 8, status: "uploading", phase: "Uploading", progress: 0 };
  globalThis.fetch = async (_input, init) => {
    calls++;
    if (init?.method === "PUT") { controller.abort(); throw controller.signal.reason; }
    return Response.json(state);
  };
  try {
    await assert.rejects(transferImport(new File(["0123456789"], "clip.mp4"), state, controller.signal, () => undefined), { name: "AbortError" });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("invalid resume metadata never reaches a file slice or upload", async () => {
  const originalFetch = globalThis.fetch;
  const initial: ImportSession = { id: "invalid", name: "clip.mp4", kind: "upload", size: 10, offset: 0,
    chunkSize: 8, status: "uploading", phase: "Uploading", progress: 0 };
  let sliced = false;
  const file = { size: 10, slice() { sliced = true; throw new Error("Must not slice"); } } as unknown as File;
  try {
    for (const changes of [{ offset: -1 }, { offset: 11 }, { offset: 1.5 }, { chunkSize: 0 }, { chunkSize: 40 * 1024 ** 3 }, { size: 9 }]) {
      globalThis.fetch = async () => Response.json({ ...initial, ...changes });
      await assert.rejects(transferImport(file, initial, new AbortController().signal, () => undefined), /invalid upload details/);
    }
    assert.equal(sliced, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("an unreadable local file gives a copyable file-access report", async () => {
  const file = { size: 10, slice: () => ({ arrayBuffer: async () => { throw new DOMException("private local path", "NotReadableError"); } }) } as unknown as File;
  await assert.rejects(uploadIdentity(file), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.diagnostic.code, "FILE_READ_FAILED");
    assert.equal(error.diagnostic.systemCode, "NotReadableError");
    assert.doesNotMatch(error.message, /private local path/);
    assert.match(error.diagnostic.nextStep, /another local folder/);
    return true;
  });
});

test("a stalled local read times out without hashing or reading another sample later", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (bytes: ArrayBuffer) => void;
  let reads = 0;
  const file = { size: 10, slice: () => { reads++; return { arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) }; } } as unknown as File;
  const pending = uploadIdentity(file);
  const rejected = assert.rejects(pending, error => { assert.ok(error instanceof ApiError); assert.equal(error.diagnostic.code, "FILE_READ_TIMEOUT"); return true; });
  t.mock.timers.tick(29_999);
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await rejected;
  finish(new ArrayBuffer(10));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1, "Late file reads cannot continue preparing a timed-out import");
});

test("cancelling preparation releases a stalled file read immediately without reporting a failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clearDiagnostics();
  const controller = new AbortController();
  const file = { size: 10, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) } as unknown as File;
  const pending = uploadIdentity(file, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort(); await rejected;
  t.mock.timers.tick(30_000);
  assert.equal(getDiagnostics().length, 0);
});

test("missing secure-context APIs produce a report instead of breaking error handling", async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  let sliced = false;
  const file = { size: 10, slice: () => { sliced = true; throw new Error("Unexpected read"); } } as unknown as File;
  await assert.rejects(uploadIdentity(file), error => {
    assert.ok(error instanceof ApiError); assert.equal(error.diagnostic.code, "BROWSER_CRYPTO_UNAVAILABLE");
    assert.ok(error.diagnostic.id); assert.match(error.diagnostic.nextStep, /localhost:5173/); return true;
  });
  assert.equal(sliced, false);
});

test("creating a file import times out without retrying a possibly accepted request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal!: AbortSignal;
  const request = t.mock.method(globalThis, "fetch", async (_input, init: RequestInit) => {
    signal = init.signal!;
    // Simulate an unresponsive fetch even after cancellation.
    return new Promise<Response>(() => {});
  });
  const pending = createUploadImport(new File(["bytes"], "local.mp4"), "identity");
  const rejected = assert.rejects(pending, error => {
    assert.ok(error instanceof ApiError); assert.equal(error.diagnostic.code, "IMPORT_QUEUE_TIMEOUT");
    assert.equal(error.diagnostic.endpoint, "/api/imports"); assert.match(error.message, /may already be queued/); return true;
  });
  t.mock.timers.tick(30_000); await rejected;
  assert.equal(signal.aborted, true); assert.equal(request.mock.callCount(), 1);
});

test("file-import confirmation deadline includes a stalled response body", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_input, init: RequestInit) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"id":'));
      init.signal!.addEventListener("abort", () => stream.error(init.signal!.reason), { once: true });
    },
  }), { status: 201 }));
  const pending = createUploadImport(new File(["bytes"], "local.mp4"), "identity");
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.diagnostic.code === "IMPORT_QUEUE_TIMEOUT");
  await Promise.resolve(); t.mock.timers.tick(30_000); await rejected;
});

test("successful file preparation creates one resumable import and clears its deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal!: AbortSignal;
  const file = new File(["video bytes"], "local.mp4", { lastModified: 7 });
  const identity = await uploadIdentity(file);
  const request = t.mock.method(globalThis, "fetch", async (url, init: RequestInit) => {
    assert.equal(url, "/api/imports"); assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body as string), { name: file.name, size: file.size, lastModified: 7, identity });
    signal = init.signal!;
    return Response.json({ id: "created", status: "uploading" }, { status: 201 });
  });
  const result = await createUploadImport(file, identity);
  assert.equal(result.id, "created"); t.mock.timers.tick(30_000);
  assert.equal(signal.aborted, false); assert.equal(request.mock.callCount(), 1);
});

test("cancelling a pending queue request aborts it without recording a timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); clearDiagnostics();
  let signal!: AbortSignal;
  t.mock.method(globalThis, "fetch", async (_input, init: RequestInit) => {
    signal = init.signal!; return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  });
  const controller = new AbortController();
  const pending = createUploadImport(new File(["bytes"], "local.mp4"), "identity", controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort(); await rejected;
  assert.equal(signal.aborted, true); t.mock.timers.tick(30_000);
  assert.equal(getDiagnostics().length, 0);
});
