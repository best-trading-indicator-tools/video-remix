import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { StoredSource } from "../server/store.js";

const exec = promisify(execFile);

test("a full-video batch renders 15s and 30s sources intact and appends the complete outro to each", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-full-video-"));
  process.env.DATA_DIR = path.join(directory, "workspace");
  process.env.AUTO_AI = "false";
  process.env.AUTO_LOCAL_AI = "false";
  process.env.WHISPER_CACHE_DIR = path.join(directory, "no-model");
  const { paths } = await import("../server/config.js");
  const { initStore, saveStore, state } = await import("../server/store.js");
  const { stopQueue } = await import("../server/queue.js");
  const { createApp } = await import("../server/app.js");
  const { probeMedia } = await import("../server/engine.js");
  await initStore();
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    assert.ok(String(input).startsWith(base + "/"), "This test must never call an external provider");
    return fetchOriginal(input, init);
  });
  try {
    const media = async (name: string, duration: number, color: string, frequency: number): Promise<StoredSource> => {
      const id = randomUUID(), filePath = path.join(paths.uploads, `${id}.mp4`);
      await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=${color}:s=160x90:r=30:d=${duration}`,
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${duration}`, "-c:v", "libx264", "-threads", "1",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", filePath]);
      return { id, name, filePath, thumbnailPath: path.join(paths.thumbnails, `${id}.jpg`),
        ...await probeMedia(filePath), size: (await stat(filePath)).size, createdAt: new Date().toISOString(), url: "", thumbnailUrl: "" };
    };
    const sources = [await media("15 second original.mp4", 15, "red", 440), await media("30 second original.mp4", 30, "red", 440)];
    const outro = await media("2 second outro.mp4", 2, "blue", 880);
    state.sources.push(...sources);
    state.broll.push({ ...outro, tags: [] });
    await saveStore();
    const response = await fetch(`${base}/api/auto/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      items: sources.map(source => ({ sourceId: source.id, variants: 3, options: {
        durationMode: "full", targetDuration: 5, versionMode: "angles", narration: true, aspect: "original",
        captions: "keep", audio: "off", pacing: { mode: "tight" }, editorialMode: "repair", finishedReview: false, supportingVisuals: "off",
        ownFootage: [{ id: randomUUID(), assetId: outro.id, appendToEnd: true, mode: "insert", at: 0, start: 0, end: 2, audio: "clip", fit: "contain" }],
      } })),
    }) });
    assert.equal(response.status, 201, await response.clone().text());
    const deadline = Date.now() + 70_000;
    while (state.jobs.some(job => ["queued", "processing"].includes(job.status)) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(state.jobs.length, 2, "Full mode creates exactly one export per video even with stale version settings");
    for (const source of sources) {
      const job = state.jobs.find(job => job.sourceId === source.id)!;
      assert.equal(job.status, "completed", job.error ?? job.phase);
      assert.equal(job.editorialModeApplied, "check", "Automatic repairs must not recut a full-video export");
      assert.deepEqual(job.settings.segments, [{ start: 0, end: source.duration }]);
      assert.equal(job.summary!.narration, false);
      assert.equal(job.settings.speed, 1);
      assert.equal(job.summary!.outputDuration, source.duration + outro.duration);
      const rendered = await probeMedia(job.outputPath);
      assert.ok(Math.abs(rendered.duration - (source.duration + outro.duration)) < 0.1);
      assert.equal(rendered.hasAudio, true);
      for (const [time, channel] of [[0.2, 0], [source.duration - 0.2, 0], [source.duration + 0.2, 2], [source.duration + 1.8, 2]]) {
        const frame = (await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", job.outputPath, "-frames:v", "1",
          "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
        assert.ok(frame[channel]! > frame[2 - channel]! + 50, `Expected original then outro picture at ${time}s`);
      }
      for (const [time, frequency] of [[source.duration - 1.2, 440], [source.duration + 0.2, 880]]) {
        const audio = (await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", job.outputPath, "-t", "1",
          "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1"], { encoding: "buffer" })).stdout;
        let crossings = 0;
        for (let i = 2; i < audio.length; i += 2) if (audio.readInt16LE(i - 2) < 0 && audio.readInt16LE(i) >= 0) crossings++;
        assert.ok(Math.abs(crossings - frequency) < 12, "Both the original ending and outro retain their own sound at normal speed");
      }
    }
  } finally {
    await stopQueue();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
