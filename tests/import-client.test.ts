import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { uploadIdentity, transferImport } from "../src/import-client.js";
import type { ImportSession } from "../shared/imports.js";

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
