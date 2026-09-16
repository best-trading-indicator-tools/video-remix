import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { installSpeakerFocusRoutes } from "../server/speaker-focus-routes.js";
import { state, type StoredSource } from "../server/store.js";
import type { SpeakerFocusResult } from "../server/speaker-focus.js";

test("face framing API bounds source access, rejects overlapping work, and cancels disconnected analysis", { timeout: 15000 }, async () => {
  const source: StoredSource = { id: "aacaa565-781a-440c-b0bf-8b76f167e0c8", name: "Interview.mp4", size: 40 * 1024 ** 3,
    duration: 7200, width: 1920, height: 1080, fps: 30, hasAudio: true, createdAt: new Date().toISOString(),
    url: "/video", thumbnailUrl: "/thumbnail", filePath: "/private/registered/source.mp4", thumbnailPath: "/private/thumbnail.jpg" };
  const saved = state.sources;
  state.sources = [source];
  const result: SpeakerFocusResult = { status: "tracked", tracks: [{ cutIndex: 0, start: 3600, end: 3630,
    keyframes: [{ time: 3600, x: 0.3, y: 0.4 }, { time: 3630, x: 0.7, y: 0.4 }], coverage: 1 }],
    sampledFrames: 60, detectedFrames: 60, multipleFaces: false };
  const app = express(); app.use(express.json());
  let calls = 0, hold = false;
  let entered!: () => void, aborted!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const abortedPromise = new Promise<void>(resolve => { aborted = resolve; });
  installSpeakerFocusRoutes(app, async options => {
    calls++;
    assert.equal(options.source.filePath, source.filePath);
    assert.deepEqual(options.cuts, [{ start: 3600, end: 3630 }]);
    if (hold) {
      entered();
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted(); reject(options.signal.reason); }, { once: true }));
    }
    return result;
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/speaker-focus`;
  const body = { sourceId: source.id, cuts: [{ start: 3600, end: 3630 }], seed: { x: 0.5, y: 0.5 } };
  const post = (value: unknown, signal?: AbortSignal) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal });
  try {
    for (const patch of [{ sourceId: "../../private" }, { cuts: [] }, { cuts: [{ start: 0, end: 7201 }] },
      { cuts: Array.from({ length: 61 }, () => ({ start: 1, end: 2 })) }, { seed: { x: 2, y: 0.5 } },
      { filePath: "/another/file.mp4" }, { cuts: [{ start: 1, end: 2, filePath: "/other" }] }]) {
      assert.equal((await post({ ...body, ...patch })).status, 400);
    }
    assert.equal((await post({ ...body, sourceId: "3f4509be-8c84-4cec-aa7c-0af38bd794d9" })).status, 404);
    assert.equal(calls, 0);
    source.fileSignature = { dev: 0, ino: 0, size: source.size, mtimeMs: 0 };
    assert.equal((await post(body)).status, 409, "A replaced/missing linked original must be rejected before analysis");
    delete source.fileSignature;
    const response = await post(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(calls, 1);
    hold = true;
    const controller = new AbortController();
    const pending = post(body, controller.signal);
    const rejected = assert.rejects(pending, /abort/i);
    await enteredPromise;
    assert.equal((await post(body)).status, 409);
    assert.equal(calls, 2);
    controller.abort();
    await rejected; await abortedPromise;
    hold = false;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await post(body)).status, 200, "Cancellation releases the analysis slot");
  } finally {
    state.sources = saved;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
