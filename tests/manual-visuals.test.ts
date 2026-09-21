import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type RenderJob, type Transcript, type VisualSource } from "../shared/types.js";
import { settingsSchema } from "../server/schema.js";
import { prepareManualVisuals } from "../server/manual-visuals.js";
import { captureFinishingPreset, restoreFinishingPresets } from "../shared/finishing-presets.js";
import type { StoredJob, StoredSource } from "../server/store.js";
import { probeAudio } from "../server/engine.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const choices: VisualSource[] = ["pixabay", "pexels", "hyperframes", "remotion", "library"];

test("Manual accepts all visual combinations and saves preferences without asset IDs in finishing presets", () => {
  for (let mask = 0; mask < 32; mask++) {
    const visualSources = choices.filter((_, index) => mask & (1 << index));
    const settings = { ...DEFAULT_SETTINGS, visualSources, brollIds: [randomUUID()], brollCount: 7, brollMaxCoverage: 35 };
    assert.deepEqual(settingsSchema.parse(settings).visualSources, visualSources);
    const preset = captureFinishingPreset("manual", "My visuals", settings, "visuals");
    assert.deepEqual(restoreFinishingPresets({ version: 1, presets: [preset] })[0]?.settings.visualSources, visualSources);
    assert.equal(preset.settings.brollCount, 7);
    assert.equal(preset.settings.brollMaxCoverage, 35);
    assert.equal("brollIds" in preset.settings, false);
  }
  for (const patch of [{ visualSources: ["unknown"] }, { visualSources: ["library", "library"] }, { brollCount: 0 }, { brollMaxCoverage: 101 }, { brollIds: ["bad"] }])
    assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...patch }).success, false);
});

test("Manual visuals follow actual shifted trims and reordered cuts at playback speed without changing settings", async () => {
  const source = { id: randomUUID(), name: "source.mp4", duration: 30, hasAudio: true, fps: 30 } as StoredSource;
  const transcript: Transcript = { duration: 30, language: "en", segments: Array.from({ length: 30 }, (_, index) => ({
    start: index, end: index + 0.8, text: String(index), words: [{ word: String(index), start: index, end: index + 0.8, probability: 1 }],
  })) };
  for (const patch of [{ trimStart: 2, trimEnd: 12, timeShift: 3 }, { segments: [{ start: 20, end: 26 }, { start: 4, end: 10 }] }]) {
    const job = { settings: { ...DEFAULT_SETTINGS, ...patch, speed: 2, visualSources: choices, brollCount: 5, brollMaxCoverage: 40 } } as StoredJob;
    const before = structuredClone(job.settings);
    let called = false;
    await prepareManualVisuals({ source, job, assets: [], workDir: "/unused", signal: new AbortController().signal, onPhase: () => {} }, {
      available: async () => true, sourceTranscript: async () => transcript,
      prepare: async input => {
        called = true;
        assert.equal(input.job.auto, undefined);
        assert.deepEqual(input.options, before);
        const expected = patch.segments ? [20, 21, 22, 23, 24, 25, 4, 5, 6, 7, 8, 9] : [5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
        assert.deepEqual(input.transcript?.segments.map(segment => segment.text), expected.map(String));
        assert.deepEqual(input.transcript?.segments.map(segment => segment.start), expected.map((_, index) => index / 2));
        assert.equal(input.transcript?.duration, expected.length / 2);
        assert.equal(job.summary?.outputDuration, expected.length / 2);
        return [];
      },
    });
    assert.equal(called, true);
    assert.deepEqual(job.settings, before);
  }
  for (const settings of [{ ...DEFAULT_SETTINGS }, { ...DEFAULT_SETTINGS, visualSources: choices, brollMaxCoverage: 0 }]) {
    assert.deepEqual(await prepareManualVisuals({ source, job: { settings } as StoredJob, assets: [], workDir: "/unused", signal: new AbortController().signal, onPhase: () => {} }, {
      available: async () => { throw new Error("Off must not start analysis"); },
      prepare: async () => { throw new Error("Off must not search or render visuals"); },
    }), []);
  }
});

test("replacement speech uses the looped output clock, and missing speech or cancellation never changes Manual settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "manual-visuals-audio-"));
  try {
    const audioPath = path.join(directory, "replacement.wav");
    await exec("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=1", audioPath]);
    const source = { name: "source.mp4", duration: 30, hasAudio: true, fps: 30 } as StoredSource;
    const job = { settings: { ...DEFAULT_SETTINGS, trimStart: 10, trimEnd: 18, speed: 2, visualSources: ["pexels"] } } as StoredJob;
    const before = structuredClone(job.settings);
    const input = { source, job, assets: [], workDir: directory, audioPath, signal: new AbortController().signal, onPhase: () => {} };
    await prepareManualVisuals(input, {
      available: async () => true,
      sourceTranscript: async () => { throw new Error("The source speech must not be used with replacement audio"); },
      transcribe: async request => {
        const duration = await probeAudio(request.input);
        assert.ok(Math.abs(duration - 4) < 0.01, "Replacement audio is looped and trimmed to the output length, without speed adjustment");
        return { duration: 4, language: "en", segments: [{ start: 2, end: 3, text: "replacement speech", words: [] }] };
      },
      prepare: async request => {
        assert.equal(request.transcript?.segments[0]?.start, 2);
        assert.equal(request.transcript?.segments[0]?.text, "replacement speech");
        return [];
      },
    });
    assert.deepEqual(job.settings, before);
    await prepareManualVisuals({ ...input, audioPath: undefined }, { available: async () => false, prepare: async request => {
      assert.equal(request.transcript, undefined); return [];
    } });
    assert.ok(job.notes?.some(note => note.includes("No speech transcript")));
    await assert.rejects(prepareManualVisuals({ ...input, signal: AbortSignal.abort() }), { name: "AbortError" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Manual API exports selected library shots with unchanged source audio, validates assets and protects active clips", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "manual-visuals-"));
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined, logs = "";
  const post = (url: string, body: unknown) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const sourceFile = path.join(directory, "source.mp4"), brollFile = path.join(directory, "broll.mp4");
    for (const [file, color, frequency, duration] of [[sourceFile, "blue", 440, 18], [brollFile, "red", 990, 4]] as const)
      await exec("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=${color}:s=320x180:r=24:d=${duration}`,
        "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`, "-c:v", "libx264", "-threads", "1", "-c:a", "aac", file]);
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: path.join(directory, "data"), AUTO_AI: "false",
        DEEPSEEK_API_KEY: "", PEXELS_API_KEY: "", PIXABAY_API_KEY: "", WHISPER_CACHE_DIR: path.join(directory, "no-model") }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { logs = (logs + chunk.toString()).slice(-10000); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
      await sleep(100);
    }
    assert.ok(ready, logs);
    const upload = async (url: string, file: string, name: string) => {
      const body = new FormData(); body.append("videos", new Blob([await readFile(file)]), name);
      const response = await fetch(base + url, { method: "POST", body });
      assert.equal(response.status, 201, await response.clone().text()); return response.json();
    };
    const source = (await upload("/api/sources", sourceFile, "sunset coast.mp4")).sources[0];
    const asset = (await upload("/api/broll", brollFile, "sunset coast broll.mp4")).assets[0];
    const settings = { ...DEFAULT_SETTINGS, trimStart: 2, trimEnd: 17, timeShift: 1, speed: 1.25,
      visualSources: ["library"], brollIds: [asset.id], brollCount: 1, brollMaxCoverage: 30 };
    const payload = (patch = {}) => ({ items: [{ sourceId: source.id, settings: { ...settings, ...patch } }], variants: 1, randomize: false });
    for (const brollIds of [[], [randomUUID()]]) assert.equal((await post("/api/jobs", payload({ brollIds }))).status, 400);
    const created = await post("/api/jobs", payload());
    assert.equal(created.status, 201, await created.clone().text());
    const id = (await created.json()).jobs[0].id;
    assert.equal((await fetch(`${base}/api/broll/${asset.id}`, { method: "DELETE" })).status, 409);
    let job: RenderJob | undefined;
    for (let attempt = 0; attempt < 250; attempt++) {
      job = (await (await fetch(base + "/api/jobs")).json()).jobs.find((item: RenderJob) => item.id === id);
      if (job && !["queued", "processing"].includes(job.status)) break;
      await sleep(200);
    }
    assert.equal(job?.status, "completed", JSON.stringify(job) + logs);
    assert.equal(job!.auto, undefined);
    assert.deepEqual(job!.settings, settings);
    assert.equal(job!.summary?.outputDuration, 12);
    assert.equal(job!.supportingVisuals?.length, 1);
    const visual = job!.supportingVisuals![0]!;
    assert.equal(visual.assetId, asset.id);
    assert.ok(visual.end - visual.start <= 12 * 0.3 + 0.001);
    const output = path.join(directory, "result.mp4");
    await writeFile(output, Buffer.from(await (await fetch(base + job!.downloadUrl)).arrayBuffer()));
    const rgb = async (time: number) => [...(await exec("ffmpeg", ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" })).stdout];
    const blue = await rgb(0.5), red = await rgb((visual.start + visual.end) / 2);
    assert.ok(blue[2]! > 180 && blue[0]! < 70, String(blue));
    assert.ok(red[0]! > 180 && red[2]! < 70, String(red));
    const { stdout } = await exec("ffmpeg", ["-v", "error", "-ss", String(visual.start + 0.1), "-i", output, "-t", "1", "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"], { encoding: "buffer" });
    const samples = Array.from({ length: stdout.length / 4 }, (_, i) => stdout.readFloatLE(i * 4));
    const energy = (frequency: number) => Math.hypot(...[Math.cos, Math.sin].map(fn => samples.reduce((sum, sample, i) => sum + sample * fn(2 * Math.PI * frequency * i / 8000), 0)));
    assert.ok(energy(440) > energy(990) * 10, "The source soundtrack continues underneath the B-roll, without the B-roll's tone");
  } finally {
    if (server && server.exitCode === null) { const stopped = new Promise(resolve => server!.once("exit", resolve)); server.kill("SIGTERM"); await stopped; }
    await rm(directory, { recursive: true, force: true });
  }
});
