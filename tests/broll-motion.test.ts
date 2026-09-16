import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runLocal } from "../server/auto-process.js";
import { inspectBrollWindows } from "../server/broll-motion.js";

async function fixture(t: TestContext, filter: string, duration = 4) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "broll-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "clip.mp4");
  await runLocal("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", filter,
    "-t", String(duration), "-an", "-c:v", "libx264", "-threads", "1",
    "-pix_fmt", "yuv420p", filePath,
  ]);
  return { filePath, duration, width: 320, height: 180 };
}

test("moving MP4 produces bounded ranked windows with portrait crop retention", async (t) => {
  const asset = await fixture(t, "testsrc2=size=320x180:rate=24:duration=12", 12);
  const progress: number[][] = [];
  const windows = await inspectBrollWindows(asset, 9 / 16, new AbortController().signal, undefined,
    (checked, total) => progress.push([checked, total]));
  assert.deepEqual(progress, [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]], "Report every decoded window, not just the whole asset");
  assert.ok(windows.length > 0 && windows.length <= 3);
  assert.ok(windows.every((window) => window.motion > 0 && window.motion <= 1));
  assert.ok(windows.every((window) => window.duration === 3.6));
  assert.ok(windows.every((window) => window.sourceStart + window.duration <= asset.duration + 0.001));
  assert.equal(windows[0]!.cropRetention, (9 / 16) / (320 / 180));
  assert.deepEqual(windows.map((window) => window.score), windows.map((window) => window.score).sort((a, b) => b - a));
});

test("still-image MP4, black footage, and a single scene cut do not count as motion", async (t) => {
  for (const filter of [
    "testsrc2=size=320x180:rate=24:duration=4,select=eq(n\\,0),loop=loop=-1:size=1:start=0,setpts=N/24/TB",
    "color=black:size=320x180:rate=24:duration=4",
    "color=gray:size=320x180:rate=24:duration=4,negate=enable='gte(t,2)'",
  ]) {
    const asset = await fixture(t, filter);
    assert.deepEqual(await inspectBrollWindows(asset, 9 / 16, new AbortController().signal), []);
  }
});

test("samples later intervals when the source starts with a still", async (t) => {
  const asset = await fixture(t,
    "testsrc2=size=320x180:rate=24:duration=4,tpad=start_duration=8:start_mode=clone", 12);
  const windows = await inspectBrollWindows(asset, 9 / 16, new AbortController().signal);
  assert.ok(windows.length > 0);
  assert.ok(windows[0]!.sourceStart >= 8);
});

test("movement cropped out of portrait framing cannot qualify the clip", async (t) => {
  const asset = await fixture(t,
    "testsrc2=size=320x180:rate=24:duration=4,drawbox=x=96:y=0:w=128:h=180:color=gray:t=fill");
  assert.deepEqual(await inspectBrollWindows(asset, 9 / 16, new AbortController().signal), []);
  const wideWindows = await inspectBrollWindows(asset, 16 / 9, new AbortController().signal);
  assert.ok(wideWindows.length > 0);
  assert.equal(wideWindows[0]!.cropRetention, 1);
});

test("the exact final trimmed interval must contain motion even when another window is moving", async (t) => {
  const asset = await fixture(t,
    "testsrc2=size=320x180:rate=24:duration=4,tpad=start_duration=4:start_mode=clone", 8);
  const signal = new AbortController().signal;
  assert.ok((await inspectBrollWindows(asset, 9 / 16, signal)).length);
  assert.deepEqual(await inspectBrollWindows(asset, 9 / 16, signal, { sourceStart: 0, duration: 2.4 }), []);
  const exact = await inspectBrollWindows(asset, 9 / 16, signal, { sourceStart: 4.3, duration: 2.4 });
  assert.equal(exact.length, 1);
  assert.equal(exact[0]!.sourceStart, 4.3);
  assert.equal(exact[0]!.duration, 2.4);
});

test("cancellation before and during inspection propagates and removes temporary frames", async (t) => {
  const asset = await fixture(t, "testsrc2=size=320x180:rate=24:duration=12", 12);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inspectBrollWindows(asset, 9 / 16, controller.signal), { name: "AbortError" });
  const previous = (await readdir(os.tmpdir())).filter((name) => name.startsWith("broll-motion-"));
  const during = new AbortController();
  const pending = inspectBrollWindows(asset, 9 / 16, during.signal);
  const timer = setTimeout(() => during.abort(), 15);
  try {
    await assert.rejects(pending, { name: "AbortError" });
    const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith("broll-motion-"));
    assert.deepEqual(after, previous);
  } finally { clearTimeout(timer); }
});

test("invalid metadata cannot trigger an unbounded media analysis", async () => {
  const asset = { filePath: "/does-not-exist.mp4", duration: 10, width: 320, height: 180 };
  for (const invalid of [
    { ...asset, duration: Infinity }, { ...asset, duration: 0.5 },
    { ...asset, width: NaN }, { ...asset, height: -1 },
  ]) assert.deepEqual(await inspectBrollWindows(invalid, 9 / 16, new AbortController().signal), []);
  assert.deepEqual(await inspectBrollWindows(asset, NaN, new AbortController().signal), []);
});
