import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type RenderJob, type RemixSettings, type VideoSource } from "../shared/types.js";
import { geometry } from "../server/engine.js";
import { createShortDraft, validateShortDraft } from "../shared/shorts.js";

const exec = promisify(execFile);
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const ffmpeg = (args: string[]) => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-filter_threads", "1", ...args],
  { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, timeout: 20000 });

async function probe(file: string) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  return JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number; duration?: string }[]; format: { duration: string } };
}

async function colorAt(file: string, time: number) {
  const { stdout } = await ffmpeg(["-ss", String(time), "-i", file, "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
  assert.equal(stdout.length, 3);
  return [...stdout];
}

async function toneAt(file: string, start: number) {
  const { stdout } = await ffmpeg(["-ss", String(start), "-i", file, "-t", "0.2", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]);
  const values = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length));
  assert.ok(values.length >= 3000, "Each selected moment retains audible source samples");
  let crossings = 0;
  let energy = 0;
  for (let index = 1; index < values.length; index++) {
    if (values[index - 1]! <= 0 && values[index]! > 0) crossings++;
    energy += values[index]! ** 2;
  }
  assert.ok(Math.sqrt(energy / values.length) > 0.02, "Selected source sound must remain audible");
  return crossings * 16000 / values.length;
}

test("explicit portrait dimensions stay exact with awkward source ratios and either fit mode", () => {
  for (const [width, height, fit] of [[160, 245, "crop"], [160, 1231, "contain"]] as const) {
    const source = { width, height, duration: 1, fps: 30, hasAudio: false };
    for (const [resolution, expected] of [["720", { width: 720, height: 1280 }], ["1080", { width: 1080, height: 1920 }]] as const)
      assert.deepEqual(geometry(source, { ...DEFAULT_SETTINGS, aspect: "9:16", resolution, fit }), expected);
  }
});

test("timestamp shorts preserve distant sequence order, names, portrait resolution and sound", { timeout: 90000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-short-render-"));
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let log = "";
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const listJobs = async () => ((await (await fetch(`${base}/api/jobs`)).json()) as { jobs: RenderJob[] }).jobs;
  const upload = async (file: string) => {
    const body = new FormData();
    body.append("videos", new Blob([await readFile(file)]), path.basename(file));
    const response = await fetch(`${base}/api/sources`, { method: "POST", body });
    assert.equal(response.status, 201, await response.clone().text());
    const { sources } = await response.json() as { sources: VideoSource[] };
    assert.equal(sources.length, 1);
    return sources[0]!;
  };
  const finished = async (ids: string[]) => {
    const deadline = Date.now() + 30000;
    let jobs: RenderJob[] = [];
    while (Date.now() < deadline) {
      jobs = (await listJobs()).filter(job => ids.includes(job.id));
      if (jobs.length === ids.length && jobs.every(job => !["queued", "processing"].includes(job.status))) {
        assert.ok(jobs.every(job => job.status === "completed"), `${JSON.stringify(jobs)}\n${log}`);
        return ids.map(id => jobs.find(job => job.id === id)!);
      }
      await sleep(75);
    }
    throw new Error(`Short rendering timed out: ${JSON.stringify(jobs)}\n${log}`);
  };
  const batch = async (source: VideoSource, items: { title: string; settings: RemixSettings }[]) => {
    const response = await post("/api/jobs", { items: items.map(item => ({ sourceId: source.id, ...item })), variants: 1, randomize: false });
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json() as { jobs: RenderJob[]; batchId: string };
    return { ...result, jobs: await finished(result.jobs.map(job => job.id)) };
  };
  const download = async (job: RenderJob) => {
    const response = await fetch(`${base}${job.downloadUrl}`);
    assert.equal(response.status, 200);
    const file = path.join(directory, `${job.id}.mp4`);
    await writeFile(file, new Uint8Array(await response.arrayBuffer()));
    return { file, disposition: response.headers.get("content-disposition")! };
  };
  try {
    const longFile = path.join(directory, "one-minute-recording.mp4");
    await ffmpeg([
      "-f", "lavfi", "-i", "color=red:s=320x180:r=12:d=60,drawbox=x=0:y=0:w=iw:h=ih:c=green:t=fill:enable='gte(t,10)*lt(t,50)',drawbox=x=0:y=0:w=iw:h=ih:c=blue:t=fill:enable='gte(t,50)'",
      "-f", "lavfi", "-i", "aevalsrc='0.1*sin(2*PI*if(lt(t,10),440,if(lt(t,50),660,880))*t)':s=48000:d=60",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-g", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", longFile,
    ]);
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: path.join(directory, "data"),
        RENDER_CONCURRENCY: "1", AUTO_AI: "false", DEEPSEEK_API_KEY: "", PIXABAY_API_KEY: "",
        WHISPER_CACHE_DIR: path.join(directory, "no-model"), MAX_FILE_SIZE_MB: "10" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { log = (log + chunk.toString()).slice(-12000); });
    const deadline = Date.now() + 10000;
    while (true) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* Listener starting. */ }
      assert.ok(Date.now() < deadline && server.exitCode === null, log || "Server did not start");
      await sleep(100);
    }
    const source = await upload(longFile);
    assert.ok(Math.abs(source.duration - 60) < 0.05);

    await t.test("invalid later selections reject the entire batch before creating any jobs", async () => {
      const response = await post("/api/jobs", { items: [
        { sourceId: source.id, title: "Valid first short", settings: { ...DEFAULT_SETTINGS, segments: [{ start: 2, end: 3 }] } },
        { sourceId: source.id, title: "Outside the recording", settings: { ...DEFAULT_SETTINGS, segments: [{ start: 59, end: 61 }] } },
      ], variants: 1, randomize: false });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /within the source video/i);
      assert.deepEqual(await listJobs(), []);
    });

    await t.test("same-named shorts get independent files and reordered distant audio follows its picture", async () => {
      const settings: RemixSettings = { ...DEFAULT_SETTINGS, aspect: "9:16", resolution: "1080", fps: "source" };
      const { jobs, batchId } = await batch(source, [
        { title: "Key insight", settings: { ...settings, segments: [{ start: 52, end: 53 }, { start: 3, end: 4 }, { start: 54, end: 54.5 }] } },
        { title: "Key insight", settings: { ...settings, segments: [{ start: 4, end: 5 }] } },
      ]);
      assert.ok(jobs.every(job => job.batchId === batchId && job.summary?.title === "Key insight"));
      assert.deepEqual(jobs.map(job => job.summary?.outputDuration), [2.5, 1]);
      const [first, second] = await Promise.all(jobs.map(download));
      assert.notEqual(first!.disposition, second!.disposition, "Equal short titles must still download to distinct filenames");
      assert.ok(first!.disposition.includes("Key insight") && second!.disposition.includes("Key insight"));
      for (const [item, expectedDuration] of [[first!, 2.5], [second!, 1]] as const) {
        const metadata = await probe(item.file);
        const video = metadata.streams.find(stream => stream.codec_type === "video")!;
        assert.deepEqual([video.width, video.height], [1080, 1920]);
        assert.ok(Math.abs(Number(metadata.format.duration) - expectedDuration) < 0.08);
        assert.ok(metadata.streams.some(stream => stream.codec_type === "audio"));
      }
      for (const [time, channel, frequency] of [[0.25, 2, 880], [1.25, 0, 440], [2.15, 2, 880]] as const) {
        const color = await colorAt(first!.file, time);
        assert.ok(color[channel]! > 180 && color.filter((_, index) => index !== channel).every(value => value < 45), `Wrong picture at ${time}s: ${color}`);
        assert.ok(Math.abs(await toneAt(first!.file, time) - frequency) < 15, `Wrong source sound at ${time}s`);
      }
      assert.ok((await colorAt(second!.file, 0.3))[0]! > 180);
      assert.ok(Math.abs(await toneAt(second!.file, 0.3) - 440) < 15);
    });

    await t.test("a real 1920 by 1080 source produces a 1080 by 1920 short with the selected subject", async () => {
      const hdFile = path.join(directory, "full-hd-recording.mp4");
      await ffmpeg(["-f", "lavfi", "-i", "color=red:s=1920x1080:r=12:d=2,drawbox=x=640:y=0:w=640:h=ih:c=green:t=fill,drawbox=x=1280:y=0:w=640:h=ih:c=blue:t=fill",
        "-f", "lavfi", "-i", "sine=frequency=550:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", hdFile]);
      const hd = await upload(hdFile);
      assert.deepEqual([hd.width, hd.height], [1920, 1080]);
      const { jobs } = await batch(hd, [{ title: "Portrait subject", settings: { ...DEFAULT_SETTINGS, aspect: "9:16", resolution: "1080",
        qualityCleanup: true, focalPoint: { x: 0.85, y: 0.5 }, segments: [{ start: 0.5, end: 1.5 }] } }]);
      const { file } = await download(jobs[0]!);
      const metadata = await probe(file);
      const video = metadata.streams.find(stream => stream.codec_type === "video")!;
      assert.deepEqual([video.width, video.height], [1080, 1920]);
      const color = await colorAt(file, 0.25);
      assert.ok(color[2]! > 180 && color[0]! < 45 && color[1]! < 45, `Portrait framing lost the selected subject: ${color}`);
      assert.ok(Math.abs(await toneAt(file, 0.25) - 550) < 15);
    });

    await t.test("named randomized shorts report the duration of their final render settings", async () => {
      const response = await post("/api/jobs", { items: [{ sourceId: source.id, title: "Paced excerpt",
        settings: { ...DEFAULT_SETTINGS, speed: 1.7, fps: "30", segments: [{ start: 3, end: 5 }] } }],
      variants: 1, randomize: true });
      assert.equal(response.status, 201, await response.clone().text());
      const { jobs: queued } = await response.json() as { jobs: RenderJob[] };
      const job = (await finished(queued.map(item => item.id)))[0]!;
      assert.equal(job.summary?.title, "Paced excerpt");
      const expected = job.settings.segments!.reduce((total, cut) => total + cut.end - cut.start, 0) / job.settings.speed;
      assert.ok(Math.abs(job.summary!.outputDuration - expected) < 0.001);
      const { file } = await download(job);
      assert.ok(Math.abs(Number((await probe(file)).format.duration) - expected) < 0.1);
    });

    await t.test("short draft zoom enables vertical framing when a portrait crop already uses the full source height", async () => {
      const stripedFile = path.join(directory, "top-red-bottom-blue.mp4");
      await ffmpeg(["-f", "lavfi", "-i", "color=red:s=320x180:r=12:d=1,drawbox=x=0:y=90:w=iw:h=90:c=blue:t=fill",
        "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-pix_fmt", "yuv420p", stripedFile]);
      const striped = await upload(stripedFile);
      const items = [1, 2].map(zoom => {
        const draft = createShortDraft(striped, `zoom-${zoom}`, `top-${zoom}`);
        draft.title = `Vertical framing at ${zoom}x`; draft.zoom = zoom;
        draft.cuts = [
          { id: `top-${zoom}`, start: "0", end: "0.5", focalPoint: { x: 0.5, y: 0 } },
          { id: `bottom-${zoom}`, start: "0.5", end: "1", focalPoint: { x: 0.5, y: 1 } },
        ];
        const result = validateShortDraft(draft, striped);
        assert.deepEqual(result.errors, []);
        return { title: draft.title, settings: result.settings! };
      });
      const { jobs } = await batch(striped, items);
      const [fullHeight, zoomed] = await Promise.all(jobs.map(download));
      const unchangedTop = await colorAt(fullHeight!.file, 0.2);
      const unchangedBottom = await colorAt(fullHeight!.file, 0.7);
      assert.ok(unchangedTop.every((channel, index) => Math.abs(channel - unchangedBottom[index]!) <= 3),
        `Without zoom, vertical framing cannot move a full-height crop: ${unchangedTop} vs ${unchangedBottom}`);
      const top = await colorAt(zoomed!.file, 0.2), bottom = await colorAt(zoomed!.file, 0.7);
      assert.ok(top[0]! > 220 && top[1]! < 25 && top[2]! < 25, `Zoomed upper framing should retain the red subject: ${top}`);
      assert.ok(bottom[2]! > 220 && bottom[0]! < 25 && bottom[1]! < 25, `Zoomed lower framing should retain the blue subject: ${bottom}`);
      for (const output of [fullHeight!, zoomed!]) {
        const metadata = await probe(output.file);
        const video = metadata.streams.find(stream => stream.codec_type === "video")!;
        assert.deepEqual([video.width, video.height], [1080, 1920], "Zoom changes framing without lowering export resolution");
        assert.ok(Math.abs(Number(metadata.format.duration) - 1) < 0.08);
      }
    });

    await t.test("optional local cleanup reduces temporal grain without changing the selected duration", async () => {
      const noisyFile = path.join(directory, "low-quality-recording.mkv");
      await ffmpeg(["-f", "lavfi", "-i", "color=gray:s=320x180:r=12:d=2,noise=alls=12:allf=t+u:all_seed=42",
        "-c:v", "ffv1", "-threads", "1", noisyFile]);
      const noisy = await upload(noisyFile);
      const { jobs } = await batch(noisy, [false, true].map(qualityCleanup => ({
        title: qualityCleanup ? "Cleaned picture" : "Original grain", settings: { ...DEFAULT_SETTINGS,
          qualityCleanup, segments: [{ start: 0.25, end: 1.75 }] },
      })));
      const outputs = await Promise.all(jobs.map(download));
      const temporalGrain = async (file: string) => {
        const { stdout } = await ffmpeg(["-i", file, "-an", "-vf", "format=gray", "-f", "rawvideo", "pipe:1"]);
        const frameSize = 320 * 180;
        assert.ok(stdout.length >= frameSize * 12);
        let changes = 0;
        for (let index = frameSize; index < stdout.length; index++) changes += (stdout[index]! - stdout[index - frameSize]!) ** 2;
        return changes / (stdout.length - frameSize);
      };
      const [baseline, cleaned] = await Promise.all(outputs.map(item => temporalGrain(item.file)));
      assert.ok(baseline > 0.2, "The baseline must contain measurable moving grain");
      assert.ok(cleaned < baseline * 0.95, `Cleanup should reduce temporal grain: baseline=${baseline}, cleaned=${cleaned}`);
      for (const item of outputs) {
        const metadata = await probe(item.file);
        assert.ok(Math.abs(Number(metadata.format.duration) - 1.5) < 0.08);
        assert.equal(metadata.streams.some(stream => stream.codec_type === "audio"), false);
      }
    });
  } finally {
    if (server && server.exitCode === null) {
      const child = server;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
