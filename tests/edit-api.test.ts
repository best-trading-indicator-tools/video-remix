import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { BrollAsset, EditPlan, RenderJob, VideoSource } from "../shared/types.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

// Real HTTP, persisted state, snapshots, captions, and FFmpeg output. Speech
// models and cloud providers are disabled explicitly in the isolated server.
test("saved Auto plans support isolated corrections and durable B-roll without repeating analysis", { timeout: 150000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-edit-api-"));
  const dataDirectory = path.join(directory, "workspace");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let processLog = "";
  const request = (url: string, method: string, body?: unknown) => fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const jobs = async () => ((await (await fetch(`${base}/api/jobs`)).json()) as { jobs: RenderJob[] }).jobs;
  const assertPublic = (value: unknown) => {
    const serialized = JSON.stringify(value);
    assert.ok(!serialized.includes(directory), "Public plans cannot contain workspace paths");
    for (const field of ["filePath", "outputPath", "captionPath", "thumbnailPath", "apiKey"])
      assert.ok(!serialized.includes(`"${field}"`), `Public plans cannot expose ${field}`);
  };
  const start = async () => {
    processLog = "";
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDirectory,
        RENDER_CONCURRENCY: "1", AUTO_LOCAL_AI: "false",
        WHISPER_CACHE_DIR: path.join(directory, "model-not-installed"),
        DEEPSEEK_API_KEY: "", PIXABAY_API_KEY: "", MAX_FILES: "4", MAX_FILE_SIZE_MB: "3",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => {
      processLog = (processLog + chunk.toString()).slice(-16000);
    });
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/api/health`, {
          headers: { Connection: "close" }, signal: AbortSignal.timeout(1000),
        });
        const health = await response.json() as { ok?: boolean };
        if (response.ok && health.ok) return;
      } catch { /* The isolated listener is still starting. */ }
      if (server.exitCode !== null) throw new Error(processLog);
      await sleep(100);
    }
    throw new Error(`Edit test server did not start: ${processLog}`);
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const child = server;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
      timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  };
  const completed = async (id: string) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = (await jobs()).find((item) => item.id === id);
      if (job?.status === "completed") return job;
      if (job && !["queued", "processing"].includes(job.status))
        throw new Error(`Edit failed: ${JSON.stringify(job)}\n${processLog}`);
      await sleep(100);
    }
    throw new Error(`Edit timed out: ${processLog}`);
  };
  const planOf = async (id: string) => {
    const response = await fetch(`${base}/api/jobs/${id}/plan`);
    assert.equal(response.status, 200, await response.clone().text());
    const plan = await response.json() as EditPlan;
    assertPublic(plan);
    return plan;
  };
  const download = async (url: string) => {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200, await response.clone().text());
    return Buffer.from(await response.arrayBuffer());
  };
  try {
    const sourcePath = path.join(directory, "source.mp4");
    const brollPath = path.join(directory, "broll.mp4");
    for (const [output, filter, duration] of [
      [sourcePath, "testsrc2=size=320x180:rate=24", 12],
      [brollPath, "color=red:size=320x180:rate=24", 3],
    ] as const) await exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", filter,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", String(duration), "-c:v", "libx264", "-threads", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", output,
    ]);
    await start();
    const upload = async (endpoint: string, file: string, filename: string) => {
      const form = new FormData();
      form.append("videos", new Blob([await readFile(file)]), filename);
      const response = await fetch(`${base}${endpoint}`, { method: "POST", body: form });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    };
    const source = ((await upload("/api/sources", sourcePath, "sunset coast.mp4")) as { sources: VideoSource[] }).sources[0]!;
    const broll = ((await upload("/api/broll", brollPath, "sunset sea.mp4")) as { assets: BrollAsset[] }).assets[0]!;
    const created = await request("/api/auto/jobs", "POST", {
      sourceIds: [source.id], variants: 1,
      options: { aspect: "16:9", targetDuration: 30, narration: false,
        supportingVisuals: "library", brollMatching: "tags", brollIds: [broll.id] },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const original = await completed(((await created.json()) as { jobs: RenderJob[] }).jobs[0]!.id);
    const plan = await planOf(original.id);
    const originalBytes = await download(original.downloadUrl!);
    assert.equal(original.editable, true);
    assert.equal(original.revision, 1);
    assert.equal(plan.version, 1);
    assert.equal(plan.revision, 1);
    assert.equal(plan.sourceId, source.id);
    assert.equal(plan.narration, false);
    assert.equal(plan.visuals.length, 1, "The source-name match creates an actual B-roll placement");
    const placement = plan.visuals[0]!;
    assert.equal(placement.enabled, true);
    assert.equal(placement.locked, true);
    const media = plan.media.find((item) => item.id === placement.mediaId)!;
    assert.ok(media);
    const mediaUrl = `/api/jobs/${original.id}/plan/media/${media.id}`;
    const snapshotBytes = await download(mediaUrl);
    assert.equal(digest(snapshotBytes), digest(await readFile(brollPath)));

    await t.test("invalid revisions and media references cannot enqueue jobs or expose arbitrary paths", async () => {
      assert.equal((await fetch(`${base}/api/jobs/${randomUUID()}/plan`)).status, 404);
      assert.equal((await fetch(`${base}/api/jobs/${original.id}/plan/media/${randomUUID()}`)).status, 404);
      assert.equal((await fetch(`${base}/api/jobs/${original.id}/plan/media/%2Fetc%2Fpasswd`)).status, 404);
      const count = (await jobs()).length;
      for (const [name, changes] of [
        ["stale revision", { revision: plan.revision + 1, hookText: "A hook" }],
        ["local path", { revision: plan.revision, filePath: "/etc/passwd" }],
        ["unknown visual", { revision: plan.revision, visuals: [{ ...placement, id: randomUUID() }] }],
        ["unknown media", { revision: plan.revision, visuals: [{ ...placement, mediaId: randomUUID(), locked: false }] }],
        ["visual path", { revision: plan.revision, visuals: [{ ...placement, mediaId: "/etc/passwd", locked: false }] }],
        ["oversized visual", { revision: plan.revision, visuals: [{ ...placement, end: plan.outputDuration + 60, locked: false }] }],
        ["source interval", { revision: plan.revision, cuts: [{ start: 0, end: source.duration + 10 }] }],
        ["caption interval", { revision: plan.revision, captions: [{ id: randomUUID(), start: 1, end: 1000, text: "Too late" }] }],
        ["caption path", { revision: plan.revision, captions: [{ id: randomUUID(), start: 1, end: 2, text: "Caption", path: "/etc/passwd" }] }],
        ["invalid framing", { revision: plan.revision, framing: { focalPoint: { x: 1.2, y: 0 } } }],
        ["locked crop", { revision: plan.revision, visuals: [{ ...placement, focalPoint: { x: 0, y: 0 } }] }],
      ] as const) {
        const rejected = await request(`/api/jobs/${original.id}/revisions`, "POST", changes);
        assert.ok([400, 404, 409].includes(rejected.status), `${name}: HTTP ${rejected.status} ${await rejected.clone().text()}`);
        assert.equal((await jobs()).length, count, `${name} must fail before enqueueing`);
      }
      assert.deepEqual(await planOf(original.id), plan, "Rejected changes leave the saved original untouched");
    });

    let revised!: RenderJob;
    let revisedPlan!: EditPlan;
    let narrationParent!: RenderJob;
    await t.test("hook and caption corrections render one new export while preserving the original and its chosen B-roll", async () => {
      // Removing the library upload forces revision rendering to use its saved
      // snapshot. Reselecting the old library ID would fail or omit the shot.
      assert.equal((await request(`/api/broll/${broll.id}`, "DELETE")).status, 200);
      assert.equal(digest(await download(mediaUrl)), digest(snapshotBytes));
      const before = (await jobs()).length;
      const captions = [{ id: randomUUID(), start: 1, end: 3, text: "A corrected caption, with café." }];
      const response = await request(`/api/jobs/${original.id}/revisions`, "POST", {
        revision: plan.revision, hookText: "A clearer opening", captions, correctionSeconds: 73,
      });
      assert.equal(response.status, 201, await response.clone().text());
      const queued = await response.json() as RenderJob;
      assertPublic(queued);
      assert.notEqual(queued.id, original.id);
      assert.equal(queued.parentJobId, original.id);
      assert.equal((await jobs()).length, before + 1);
      revised = await completed(queued.id);
      revisedPlan = await planOf(revised.id);
      assert.equal(revised.revision, 2);
      assert.deepEqual(revised.corrections, { captionCorrections: 1, brollChanges: 0, seconds: 73 });
      assert.equal(revisedPlan.revision, 2);
      assert.equal(revisedPlan.settings.hookText, "A clearer opening");
      assert.deepEqual(revisedPlan.captions, captions);
      assert.deepEqual(revisedPlan.cuts, plan.cuts);
      assert.deepEqual(revisedPlan.visuals, plan.visuals, "A text correction preserves every visual choice and lock");
      assert.equal(revisedPlan.narration, plan.narration);
      assert.equal(revisedPlan.audioMediaId, plan.audioMediaId);
      assert.deepEqual(revised.supportingVisuals, original.supportingVisuals);
      assert.equal((await jobs()).find((job) => job.id === original.id)!.status, "completed");
      assert.equal(digest(await download(original.downloadUrl!)), digest(originalBytes));
      assert.deepEqual(await planOf(original.id), plan);
      assert.ok(revised.captionUrl, "Saved caption corrections produce the download sidecar");
      assert.match((await download(revised.captionUrl!)).toString("utf8"), /A corrected caption, with café\./u);
      assert.notEqual(digest(await download(revised.downloadUrl!)), digest(originalBytes));
      const revisedMedia = revisedPlan.media.find((item) => item.id === placement.mediaId)!;
      assert.ok(revisedMedia);
      assert.equal(digest(await download(`/api/jobs/${revised.id}/plan/media/${revisedMedia.id}`)), digest(snapshotBytes));
    });

    await t.test("framing edits persist without replanning and completed exports expose review findings", async () => {
      const response = await request(`/api/jobs/${revised.id}/revisions`, "POST", {
        revision: revisedPlan.revision,
        framing: { fit: "crop", captionStyle: { fontSize: 40, bottomPercent: 70 } },
        cuts: revisedPlan.cuts.map(cut => ({ ...cut, focalPoint: { x: 0.1, y: 0.5 } })),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const framed = await completed((await response.json() as RenderJob).id);
      const framedPlan = await planOf(framed.id);
      assert.deepEqual(framedPlan.captions, revisedPlan.captions);
      assert.deepEqual(framedPlan.visuals, revisedPlan.visuals);
      assert.deepEqual(framedPlan.cuts[0]!.focalPoint, { x: 0.1, y: 0.5 });
      assert.deepEqual(framedPlan.settings.captionStyle, { fontSize: 40, bottomPercent: 70 });
      assert.equal(framed.qualityReport?.status, "review");
      assert.ok(framed.qualityReport?.issues.some(issue => issue.code === "text-collision"));
      assert.ok(framed.downloadUrl, "A review finding keeps the technically completed output available");
      assertPublic(framed.qualityReport);
    });

    await t.test("plans and snapshots survive restart and cuts can be corrected without a new Auto analysis", async () => {
      await stop();
      await start();
      assert.deepEqual(await planOf(original.id), plan);
      assert.deepEqual(await planOf(revised.id), revisedPlan);
      assert.equal(digest(await download(mediaUrl)), digest(snapshotBytes));
      const count = (await jobs()).length;
      const response = await request(`/api/jobs/${revised.id}/revisions`, "POST", {
        revision: revisedPlan.revision, cuts: [{ start: 0, end: 10 }],
      });
      assert.equal(response.status, 201, await response.clone().text());
      const queued = await response.json() as RenderJob;
      assert.equal(queued.parentJobId, revised.id);
      assert.equal((await jobs()).length, count + 1);
      const trimmed = await completed(queued.id);
      const trimmedPlan = await planOf(trimmed.id);
      assert.equal(trimmedPlan.revision, 3);
      assert.deepEqual(trimmedPlan.cuts, [{ start: 0, end: 10 }]);
      assert.deepEqual(trimmedPlan.captions, revisedPlan.captions);
      assert.deepEqual(trimmedPlan.visuals, revisedPlan.visuals);
      assert.equal(trimmedPlan.settings.hookText, revisedPlan.settings.hookText);
      assert.ok(Math.abs(trimmedPlan.outputDuration - 10) < 0.05);
      const output = path.join(directory, "trimmed.mp4");
      await writeFile(output, await download(trimmed.downloadUrl!));
      const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]);
      const probe = JSON.parse(stdout);
      assert.ok(Math.abs(Number(probe.format.duration) - 10) < 0.1);
      assert.ok(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"));
      assert.equal(digest(await download(original.downloadUrl!)), digest(originalBytes));

      const withoutBrollResponse = await request(`/api/jobs/${trimmed.id}/revisions`, "POST", {
        revision: trimmedPlan.revision,
        visuals: trimmedPlan.visuals.map((visual) => ({ ...visual, enabled: false, locked: false })),
      });
      assert.equal(withoutBrollResponse.status, 201, await withoutBrollResponse.clone().text());
      const withoutBroll = await completed((await withoutBrollResponse.json() as RenderJob).id);
      narrationParent = withoutBroll;
      const withoutBrollPlan = await planOf(withoutBroll.id);
      assert.ok(withoutBrollPlan.visuals.every((visual) => !visual.enabled));
      assert.deepEqual(withoutBroll.supportingVisuals, []);
      assert.deepEqual(withoutBrollPlan.captions, trimmedPlan.captions);
      assert.deepEqual(withoutBrollPlan.cuts, trimmedPlan.cuts);
      assert.equal((await jobs()).length, count + 2);
    });

    await t.test("a retained narration snapshot survives text revisions and duration-changing cuts are rejected", async () => {
      // Seed the artifact a speech synthesizer would have produced. The real
      // renderer must choose this saved 880 Hz track over the 440 Hz source;
      // no cloud speech service or installed local voice model is involved.
      await stop();
      const statePath = path.join(dataDirectory, "state.json");
      const saved = JSON.parse(await readFile(statePath, "utf8")) as {
        jobs: (RenderJob & { editPlan: EditPlan; planFiles: Record<string, string> })[];
      };
      const parent = saved.jobs.find((item) => item.id === narrationParent.id)!;
      const audioId = randomUUID();
      const audioName = `${audioId}.wav`;
      const audioPath = path.join(dataDirectory, "plans", parent.id, audioName);
      await exec("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=10",
        "-c:a", "pcm_s16le", audioPath,
      ]);
      const narrationBytes = await readFile(audioPath);
      parent.editPlan.media.push({ id: audioId, kind: "audio", name: "Saved narration fixture", duration: 10 });
      parent.editPlan.audioMediaId = audioId;
      parent.editPlan.narration = true;
      parent.planFiles[audioId] = audioName;
      parent.summary!.narration = true;
      await writeFile(statePath, JSON.stringify(saved));
      await start();
      const narratedPlan = await planOf(parent.id);
      assert.equal(narratedPlan.narration, true);
      assert.equal(narratedPlan.audioMediaId, audioId);
      const count = (await jobs()).length;
      const invalid = await request(`/api/jobs/${parent.id}/revisions`, "POST", {
        revision: narratedPlan.revision, cuts: [{ start: 0, end: 9 }],
      });
      assert.equal(invalid.status, 400, await invalid.clone().text());
      assert.match((await invalid.json() as { error: string }).error, /narration|duration/iu);
      assert.equal((await jobs()).length, count, "Changing the locked narration duration cannot enqueue a job");
      const response = await request(`/api/jobs/${parent.id}/revisions`, "POST", {
        revision: narratedPlan.revision,
        hookText: "The saved narration stays in place",
        captions: [{ id: randomUUID(), start: 2, end: 3, text: "A corrected narration caption." }],
      });
      assert.equal(response.status, 201, await response.clone().text());
      const narrated = await completed((await response.json() as RenderJob).id);
      assert.equal((await jobs()).length, count + 1);
      const next = await planOf(narrated.id);
      assert.equal(next.narration, true);
      assert.equal(next.audioMediaId, audioId);
      assert.deepEqual(next.cuts, narratedPlan.cuts);
      assert.equal(digest(await download(`/api/jobs/${parent.id}/plan/media/${audioId}`)), digest(narrationBytes));
      assert.equal(digest(await download(`/api/jobs/${narrated.id}/plan/media/${audioId}`)), digest(narrationBytes));
      const output = path.join(directory, "narration-revision.mp4");
      await writeFile(output, await download(narrated.downloadUrl!));
      const { stdout: samples } = await exec("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", "4",
        "-i", output, "-t", "0.6", "-vn", "-ac", "1", "-ar", "8000",
        "-f", "s16le", "pipe:1",
      ], { encoding: "buffer" });
      assert.ok(samples.length > 8000, "The revised output contains a usable audio interval");
      let crossings = 0;
      for (let offset = 2; offset < samples.length; offset += 2)
        if (samples.readInt16LE(offset - 2) <= 0 && samples.readInt16LE(offset) > 0) crossings++;
      const frequency = crossings * 8000 / (samples.length / 2);
      assert.ok(Math.abs(frequency - 880) < 20,
        `The saved 880 Hz narration must replace the 440 Hz source: measured ${frequency.toFixed(1)} Hz`);
    });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
