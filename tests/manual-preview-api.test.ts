import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type RemixSettings, type VideoSource } from "../shared/types.js";
import { geometry, probeMedia, renderVideo } from "../server/engine.js";
import { manualPreviewSettings } from "../server/manual-preview.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sourceInfo = { duration: 12, width: 1920, height: 1080, fps: 120, hasAudio: true };

test("manual preview preserves effective edit start, speed, ordered cuts and bounded dimensions", () => {
  const shifted = manualPreviewSettings({ ...DEFAULT_SETTINGS, trimStart: 2, trimEnd: 12, timeShift: 3 }, sourceInfo);
  assert.equal(shifted.settings.trimStart, 2, "Clamp against the complete trim before shortening it");
  assert.equal(shifted.settings.trimEnd, 7);
  assert.equal(shifted.settings.timeShift, 0);
  assert.equal(shifted.settings.fps, "60");
  assert.equal(shifted.duration, 5);
  assert.deepEqual(geometry(shifted.source, shifted.settings), { width: 1280, height: 720 });
  const slowed = manualPreviewSettings({ ...DEFAULT_SETTINGS, speed: 0.5, trimStart: 3, trimEnd: 8, timeShift: -5 }, sourceInfo);
  assert.equal(slowed.settings.trimStart, 0);
  assert.equal(slowed.settings.trimEnd, 2.5);
  assert.equal(slowed.duration, 5);
  const cuts = manualPreviewSettings({ ...DEFAULT_SETTINGS, segments: [
    { start: 0, end: 2, focalPoint: { x: 0.2, y: 0.4 } }, { start: 6, end: 12 },
  ] }, sourceInfo);
  assert.deepEqual(cuts.settings.segments, [
    { start: 0, end: 2, focalPoint: { x: 0.2, y: 0.4 } }, { start: 6, end: 9 },
  ]);
  const panoramic = manualPreviewSettings(DEFAULT_SETTINGS, { ...sourceInfo, width: 8000, height: 200 });
  assert.ok(Math.max(...Object.values(geometry(panoramic.source, panoramic.settings))) <= 1280);
  assert.throws(() => manualPreviewSettings({ ...DEFAULT_SETTINGS, trimStart: 13 }, sourceInfo), /Trim end/);
  assert.throws(() => manualPreviewSettings({ ...DEFAULT_SETTINGS, segments: [{ start: 1, end: 14 }] }, sourceInfo), /cuts/);
  const moving = manualPreviewSettings({ ...DEFAULT_SETTINGS, autoMotion: true }, sourceInfo);
  assert.equal(moving.settings.autoMotion, true);
  assert.equal(moving.motionDuration, 12);
});

test("manual preview API renders the actual edit without creating exports and manages bounded private media", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-manual-preview-"));
  const dataDirectory = path.join(directory, "data");
  const previewDirectory = path.join(dataDirectory, "previews");
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let processLog = "";
  const post = (url: string, body: unknown, signal?: AbortSignal) => fetch(`${base}${url}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  type Preview = { id: string; url: string; duration: number };
  let source: VideoSource;
  const preview = async (settings: Partial<RemixSettings> = {}) => {
    const response = await post("/api/previews", { sourceId: source.id, settings: { ...DEFAULT_SETTINGS, ...settings } });
    assert.equal(response.status, 201, await response.clone().text());
    const value = await response.json() as Preview;
    assert.deepEqual(Object.keys(value).sort(), ["duration", "id", "url"]);
    assert.ok(!JSON.stringify(value).includes(directory), "Preview responses must not expose filesystem paths");
    return value;
  };
  const downloaded = async (value: Preview) => {
    const response = await fetch(`${base}${value.url}`);
    assert.equal(response.status, 200);
    const output = path.join(directory, `${value.id}.mp4`);
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    return output;
  };
  const rgb = async (file: string, time: number) => {
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1",
      "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
    return [...stdout];
  };
  const pcm = async (file: string) => {
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-i", file, "-t", "1", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"], { encoding: "buffer" });
    return Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4));
  };
  const rms = (samples: number[]) => Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  const attachment = async (kind: string, filename: string, data: Uint8Array) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", new Blob([data]), filename);
    const response = await fetch(`${base}/api/attachments`, { method: "POST", body: form });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { id: string };
  };
  try {
    const staleId = randomUUID();
    await mkdir(path.join(previewDirectory, staleId), { recursive: true });
    await writeFile(path.join(previewDirectory, staleId, "preview.mp4"), "orphan from an earlier process");
    await writeFile(path.join(previewDirectory, "keep-notes.txt"), "unrelated file");
    const fixture = path.join(directory, "source.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=960x540:r=30:d=4",
      "-f", "lavfi", "-i", "color=c=blue:s=960x540:r=30:d=4",
      "-f", "lavfi", "-i", "color=c=lime:s=960x540:r=30:d=4",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,drawgrid=width=120:height=90:thickness=3:color=white[v]", "-map", "[v]", "-map", "3:a",
      "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "12", fixture]);
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDirectory,
        AUTO_LOCAL_AI: "false", DEEPSEEK_API_KEY: "", PIXABAY_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { processLog = (processLog + chunk.toString()).slice(-16000); });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } }
      catch { /* Starting isolated server. */ }
      if (server.exitCode !== null) throw new Error(processLog);
      await sleep(100);
    }
    assert.ok(ready, processLog);
    const form = new FormData();
    form.append("videos", new Blob([await readFile(fixture)]), "Three scenes.mp4");
    const upload = await fetch(`${base}/api/sources`, { method: "POST", body: form });
    assert.equal(upload.status, 201, await upload.clone().text());
    source = ((await upload.json()) as { sources: VideoSource[] }).sources[0]!;

    await t.test("rejects invalid sources, settings, attachments, intervals and arbitrary output paths", async () => {
      for (const [body, status] of [
        [{ sourceId: randomUUID(), settings: DEFAULT_SETTINGS }, 404],
        [{ sourceId: source.id, settings: { ...DEFAULT_SETTINGS, gamma: 99 } }, 400],
        [{ sourceId: source.id, settings: { ...DEFAULT_SETTINGS, trimStart: 20 } }, 400],
        [{ sourceId: source.id, settings: { ...DEFAULT_SETTINGS, audioId: randomUUID() } }, 400],
        [{ sourceId: source.id, settings: { ...DEFAULT_SETTINGS, subtitleId: randomUUID() } }, 400],
        [{ sourceId: source.id, settings: DEFAULT_SETTINGS, output: "/tmp/unowned.mp4" }, 400],
      ] as const) assert.equal((await post("/api/previews", body)).status, status);
      for (const id of [randomUUID(), "%2Fetc%2Fpasswd", staleId])
        assert.equal((await fetch(`${base}/api/previews/${id}/video`)).status, 404);
      assert.deepEqual(await readdir(previewDirectory), ["keep-notes.txt"], "Restart cleanup removes orphan previews but preserves unrelated files");
    });

    let plain!: Preview;
    let plainPath!: string;
    await t.test("renders five real output seconds with correct full-window shift and speed, then reuses its cache", async () => {
      const settings = { trimStart: 2, trimEnd: 12, timeShift: 3, speed: 2 };
      plain = await preview(settings);
      assert.equal(plain.duration, 5);
      plainPath = await downloaded(plain);
      const info = await probeMedia(plainPath);
      assert.ok(Math.abs(info.duration - 5) < 0.1);
      assert.ok(info.hasAudio);
      assert.ok(Math.min(info.width, info.height) <= 720 && Math.max(info.width, info.height) <= 1280);
      for (const [time, channel] of [[0.25, 0], [1.5, 2], [3.5, 1]] as const) {
        const color = await rgb(plainPath, time);
        assert.ok(color[channel]! > 200 && color.filter((_, index) => index !== channel).every(value => value < 35), `Incorrect source interval at ${time}: ${color}`);
      }
      assert.deepEqual(await preview(settings), plain);
      const ranged = await fetch(`${base}${plain.url}`, { headers: { Range: "bytes=0-63" } });
      assert.equal(ranged.status, 206);
      assert.equal((await ranged.arrayBuffer()).byteLength, 64);
    });

    await t.test("applies actual image filters, captions, replacement audio, volume and mute", async () => {
      const audioFile = path.join(directory, "voice.wav");
      await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=900:duration=2", audioFile]);
      const audio = await attachment("audio", "voice.wav", await readFile(audioFile));
      const subtitle = await attachment("subtitle", "captions.srt", new TextEncoder().encode("1\n00:00:00,000 --> 00:00:04,000\nA useful example.\n"));
      const wrongKind = await post("/api/previews", { sourceId: source.id, settings: { ...DEFAULT_SETTINGS, subtitleId: audio.id } });
      assert.equal(wrongKind.status, 400);
      const treated = await preview({ trimStart: 2, trimEnd: 12, timeShift: 3, speed: 2,
        gamma: 1.3, temperature: 0.2, noise: 0.15, sharpness: 0.5, blend: 0.3, frameBlend: 0.1,
        brightness: 0.1, saturation: 0.8, contrast: 0.9, hue: 30, zoom: 1.15, mirror: true,
        volume: 0.25, audioId: audio.id, subtitleId: subtitle.id, hookText: "A clear opening", hookDuration: 2 });
      const treatedPath = await downloaded(treated);
      assert.notDeepEqual(await rgb(treatedPath, 0.25), await rgb(plainPath, 0.25), "The preview must contain the rendered image effects");
      const samples = await pcm(treatedPath);
      const reference = await pcm(plainPath);
      assert.ok(rms(samples) / rms(reference) > 0.18 && rms(samples) / rms(reference) < 0.32, "Volume is applied to replacement audio");
      let upward = 0;
      for (let index = 1; index < samples.length; index++) if (samples[index - 1]! <= 0 && samples[index]! > 0) upward++;
      assert.ok(Math.abs(upward - 900) < 20, `Expected replacement audio at 900 Hz, got ${upward} crossings`);
      const muted = await preview({ trimEnd: 0.5, muted: true, audioId: audio.id });
      assert.equal((await probeMedia(await downloaded(muted))).hasAudio, false);
    });

    await t.test("retains ordered cut timing within the shortened preview", async () => {
      const cutPreview = await preview({ segments: [{ start: 0, end: 1 }, { start: 8, end: 12 }] });
      assert.equal(cutPreview.duration, 5);
      const file = await downloaded(cutPreview);
      assert.ok((await rgb(file, 0.25))[0]! > 200);
      assert.ok((await rgb(file, 1.5))[1]! > 200);
    });

    await t.test("camera motion in a five-second preview follows the complete edit's timing", async () => {
      const moving = await preview({ autoMotion: true });
      const movingPath = await downloaded(moving);
      const fullPath = path.join(directory, "complete-camera-move.mp4");
      await renderVideo({ input: fixture, output: fullPath, settings: { ...DEFAULT_SETTINGS, autoMotion: true, resolution: "720" },
        source: await probeMedia(fixture), workDir: path.join(directory, "motion-work"),
        signal: new AbortController().signal, onProgress: () => {} });
      const frame = async (file: string) => (await exec("ffmpeg", ["-v", "error", "-ss", "3.25", "-i", file,
        "-frames:v", "1", "-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout;
      const [actual, expected] = await Promise.all([frame(movingPath), frame(fullPath)]);
      assert.equal(actual.length, expected.length);
      const meanDifference = [...actual].reduce((sum, value, index) => sum + Math.abs(value - expected[index]!), 0) / actual.length;
      assert.ok(meanDifference < 1, `Preview must preserve the slower full-edit camera move, difference ${meanDifference}`);
    });

    await t.test("one active preview is allowed and disconnect cancellation releases its files and slot", async () => {
      const before = new Set(await readdir(previewDirectory));
      const abort = new AbortController();
      const pending = post("/api/previews", { sourceId: source.id, settings: { ...DEFAULT_SETTINGS, noise: 0.91, frameBlend: 0.5, fps: "60" } }, abort.signal)
        .then(response => ({ status: response.status }), error => ({ error: error as Error }));
      let activeFolder: string | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        activeFolder = (await readdir(previewDirectory)).find(id => !before.has(id));
        if (activeFolder) break;
        await sleep(10);
      }
      assert.ok(activeFolder, "The real renderer should create a temporary preview directory");
      assert.equal((await post("/api/previews", { sourceId: source.id, settings: DEFAULT_SETTINGS })).status, 409);
      abort.abort();
      assert.ok("error" in await pending, "Closing the client request aborts the pending preview");
      for (let attempt = 0; attempt < 100 && (await readdir(previewDirectory)).includes(activeFolder); attempt++) await sleep(25);
      assert.ok(!(await readdir(previewDirectory)).includes(activeFolder), "Cancelled output and FFmpeg work files are removed");
      await preview({ trimEnd: 0.5, hue: 5 });
    });

    await t.test("evicts older previews at the file limit without polluting jobs or persistent history", async () => {
      for (let index = 0; index < 13; index++) await preview({ trimEnd: 0.1, hue: 60 + index });
      assert.ok((await readdir(previewDirectory)).filter(id => id !== "keep-notes.txt").length <= 12);
      assert.equal((await fetch(`${base}${plain.url}`)).status, 404, "Old previews are evicted");
      assert.deepEqual((await (await fetch(`${base}/api/jobs`)).json()).jobs, []);
      assert.deepEqual((await (await fetch(`${base}/api/history`)).json()).entries, []);
      const saved = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
      assert.deepEqual(saved.jobs, []);
      assert.deepEqual(saved.history, []);
      assert.equal(await readFile(path.join(previewDirectory, "keep-notes.txt"), "utf8"), "unrelated file");
    });
  } finally {
    if (server && server.exitCode === null) {
      const child = server;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => child.kill("SIGKILL"), 7000);
        child.once("exit", () => { clearTimeout(timeout); resolve(); });
        child.kill("SIGTERM");
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
