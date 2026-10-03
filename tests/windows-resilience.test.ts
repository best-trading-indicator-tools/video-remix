import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDiskSpaceProbe, DiskSpaceUnavailableError } from "../server/disk-space.js";
import { cacheCapability } from "../server/capability-cache.js";
import { browserPath } from "../server/visuals.js";

test("disk checks distinguish a full drive from failed or invalid statistics", async () => {
  assert.equal(await createDiskSpaceProbe(async () => ({ bavail: 0, bsize: 4096 }))("drive"), 0);
  assert.equal(await createDiskSpaceProbe(async () => ({ bavail: 7, bsize: 4096 }))("drive"), 7 * 4096);
  for (const result of [{ bavail: NaN, bsize: 4096 }, { bavail: -1, bsize: 4096 }, { bavail: 7, bsize: 0 }])
    await assert.rejects(createDiskSpaceProbe(async () => result)("drive"), DiskSpaceUnavailableError);
  await assert.rejects(createDiskSpaceProbe(async () => { throw new Error("drive disconnected"); })("drive"), DiskSpaceUnavailableError);
});

test("a hung disk probe times out without accumulating more filesystem calls and can recover", async () => {
  let finish!: (value: { bavail: number; bsize: number }) => void;
  const hung = new Promise<{ bavail: number; bsize: number }>(resolve => { finish = resolve; });
  let calls = 0;
  const probe = createDiskSpaceProbe(async () => { calls++; return calls === 1 ? hung : { bavail: 50, bsize: 1024 }; }, 20);
  await Promise.all([assert.rejects(probe("drive"), DiskSpaceUnavailableError), assert.rejects(probe("drive"), DiskSpaceUnavailableError)]);
  await assert.rejects(probe("drive"), DiskSpaceUnavailableError);
  assert.equal(calls, 1, "Retries must share the outstanding read-only probe");
  finish({ bavail: 0, bsize: 1024 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await probe("drive"), 50 * 1024);
  assert.equal(calls, 2);
});

test("capability polls share slow work, expire completed results, and retry failures", async () => {
  let clock = 0, calls = 0;
  let finish!: (value: boolean) => void;
  const slow = new Promise<boolean>(resolve => { finish = resolve; });
  const check = cacheCapability(async () => { calls++; return calls === 1 ? slow : true; }, 100, () => clock);
  const first = check();
  await Promise.resolve();
  clock = 1000;
  assert.equal(check(), first, "A slow check must not be duplicated when its nominal TTL passes");
  finish(false);
  assert.equal(await first, false);
  assert.equal(await check(), false);
  clock = 1101;
  assert.equal(await check(), true);
  assert.equal(calls, 2);
  let fail = true;
  const retry = cacheCapability(async () => { if (fail) throw new Error("temporary failure"); return true; });
  await assert.rejects(retry(), /temporary failure/);
  fail = false;
  assert.equal(await retry(), true);
});

test("browser lookup detects installation and removal after the first capability check", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-browser-lookup-"));
  const candidate = path.join(directory, "browser");
  const prior = process.env.PRODUCER_HEADLESS_SHELL_PATH;
  process.env.PRODUCER_HEADLESS_SHELL_PATH = candidate;
  try {
    assert.notEqual(await browserPath(), candidate);
    await writeFile(candidate, "browser fixture; never executed");
    assert.equal(await browserPath(), candidate);
    await rm(candidate);
    assert.notEqual(await browserPath(), candidate);
  } finally {
    if (prior === undefined) delete process.env.PRODUCER_HEADLESS_SHELL_PATH;
    else process.env.PRODUCER_HEADLESS_SHELL_PATH = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
