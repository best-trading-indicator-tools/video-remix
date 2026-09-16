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
    for (const field of ["filePath", "outputPath", "captionPath", "thumbnailPath", "apiKey", "refreshBroll"])
      assert.ok(!serialized.includes(`"${field}"`), `Public plans cannot expose ${field}`);
  };
  const start = async (mockStock = false) => {
    processLog = "";
    server = spawn(process.execPath, [...(mockStock ? ["--import", path.join(directory, "mock-stock.mjs")] : []), "--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDirectory,
        RENDER_CONCURRENCY: "1", AUTO_AI: "false",
        WHISPER_CACHE_DIR: path.join(directory, "model-not-installed"),
        DEEPSEEK_API_KEY: "", PEXELS_API_KEY: "", PIXABAY_API_KEY: mockStock ? "isolated-test-key" : "", MAX_FILES: "4", MAX_FILE_SIZE_MB: "3",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk) => {
      processLog = (processLog + chunk.toString()).slice(-16000);
    });
    // Cold TS module loading competes with real browser/FFmpeg renders in the
    // full suite; retain a bound without failing healthy, slower CI workers.
    const deadline = Date.now() + 30000;
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
    assert.equal(original.editorialReport?.status, "unavailable", "Missing speech/model must never look like an editorial pass");
    assert.equal(original.editorialReport?.coverage.source, "missing");
    assert.equal(original.phase, "Needs review");
    const reviewedHistory = await (await fetch(`${base}/api/history`)).json() as { entries: { jobId: string; editorialReport?: unknown }[] };
    assert.deepEqual(reviewedHistory.entries.find(entry => entry.jobId === original.id)?.editorialReport, original.editorialReport,
      "Editorial findings must survive in durable history, separately from human acceptance");
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
        ["library refresh", { revision: plan.revision, refreshBroll: true }],
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
      assert.equal(revised.auto?.captions, "add", "Explicit nonempty caption corrections opt into added captions");
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
      assert.equal(trimmed.auto?.captions, "add", "A cuts-only revision retains the manual caption choice after restart");
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

    await t.test("explicit stock refresh changes only one saved edit and caption-only revisions never repeat the search", async () => {
      await stop();
      const statePath = path.join(dataDirectory, "state.json");
      const saved = JSON.parse(await readFile(statePath, "utf8"));
      const parent = saved.jobs.find((item: RenderJob) => item.id === narrationParent.id);
      parent.auto.supportingVisuals = "library";
      parent.auto.visualSources = ["pixabay", "remotion"];
      parent.auto.brollMatching = "ai";
      for (const media of parent.editPlan.media) if (media.kind === "broll") media.visualSource = "pixabay";
      // Seed a retained animated-card artifact. A stock refresh must reuse its
      // exact bytes and saved placement without invoking its renderer again.
      const cardId = randomUUID(), cardName = `${cardId}.mp4`;
      const cardPath = path.join(dataDirectory, "plans", parent.id, cardName);
      await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=0x152028:s=320x180:r=24:d=2",
        "-vf", "drawtext=text='Saved animated title':fontsize=18:fontcolor=white:x=20+20*t:y=75",
        "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", cardPath]);
      const cardBytes = await readFile(cardPath);
      parent.editPlan.media.push({ id: cardId, kind: "graphic", name: "Saved Remotion title", duration: 2, visualSource: "remotion" });
      const cardPlacement = { id: randomUUID(), mediaId: cardId, start: 8, end: 9, sourceStart: 0,
        enabled: true, locked: true, reason: "Retained spoken emphasis" };
      parent.editPlan.visuals.push(cardPlacement);
      parent.planFiles[cardId] = cardName;
      // The rewritten narration has a different subject from the source.
      // Search must use its saved/corrected caption timeline.
      parent.sourceTranscript = { language: "en", duration: 12, segments: [
        { start: 4, end: 7, text: "Mountain snow hiking.", words: [] },
      ] };
      parent.editPlan.captions = [{ id: "saved-speech", start: 4, end: 6.5, text: "Sunset sea coast." }];
      await writeFile(statePath, JSON.stringify(saved));
      await start();
      const noKey = await request(`/api/jobs/${parent.id}/revisions`, "POST", { revision: parent.editPlan.revision, refreshBroll: true });
      assert.equal(noKey.status, 400);
      assert.match(await noKey.text(), /Pixabay/u);
      await stop();
      const requestLog = path.join(directory, "stock-requests.jsonl");
      const emptyFlag = path.join(directory, "empty-stock");
      const sourceBytes = await readFile(sourcePath);
      await writeFile(path.join(directory, "mock-stock.mjs"), `
        import { readFile, appendFile, access } from 'node:fs/promises';
        globalThis.fetch = async (input) => {
          const url = String(input);
          if (url.startsWith('https://pixabay.com/api/videos/')) {
            await appendFile(${JSON.stringify(requestLog)}, JSON.stringify(url) + '\\n');
            const empty = await access(${JSON.stringify(emptyFlag)}).then(() => true, () => false);
            return Response.json({ hits: empty ? [] : [{ id: 456123, pageURL: 'https://pixabay.com/videos/id-456123/',
              type: 'film', tags: 'sunset, sea, waves, coast', duration: 12, user: 'Test creator', videos: {
                medium: { url: 'https://cdn.pixabay.com/video/2026/01/01/456123_test.mp4', width: 320, height: 180, size: ${sourceBytes.length} }
              } }] });
          }
          if (url.startsWith('https://cdn.pixabay.com/')) return new Response(await readFile(${JSON.stringify(sourcePath)}), { headers: { 'content-type': 'video/mp4' } });
          throw new Error('Unexpected external request in isolated refresh test');
        };
      `);
      await start(true);
      const noAIKey = await request(`/api/jobs/${parent.id}/revisions`, "POST", { revision: parent.editPlan.revision, refreshBroll: true });
      assert.equal(noAIKey.status, 400);
      assert.match(await noAIKey.text(), /DeepSeek/u);
      await stop();
      const tagged = JSON.parse(await readFile(statePath, "utf8"));
      tagged.jobs.find((item: RenderJob) => item.id === parent.id).auto.brollMatching = "tags";
      await writeFile(statePath, JSON.stringify(tagged));
      await start(true);
      const before = await planOf(parent.id);
      const count = (await jobs()).length;
      const conflict = await request(`/api/jobs/${parent.id}/revisions`, "POST", {
        revision: before.revision, refreshBroll: true, visuals: [],
      });
      assert.equal(conflict.status, 400);
      assert.equal((await jobs()).length, count);
      for (const bad of [{ brollCount: 6 }, { refreshBroll: true, brollCount: 0 }, { refreshBroll: true, brollCount: 11 }, { refreshBroll: true, brollCount: 2.5 }]) {
        assert.equal((await request(`/api/jobs/${parent.id}/revisions`, "POST", { revision: before.revision, ...bad })).status, 400);
      }
      assert.equal((await jobs()).length, count);
      const captions = [{ id: "saved-speech", start: 4, end: 6.5, text: "Sunset sea waves." }];
      const response = await request(`/api/jobs/${parent.id}/revisions`, "POST", { revision: before.revision, refreshBroll: true, brollCount: 6, captions });
      assert.equal(response.status, 201, await response.clone().text());
      const queued = await response.json() as RenderJob;
      assertPublic(queued);
      const refreshed = await completed(queued.id);
      assert.equal(refreshed.auto?.brollCount, 6);
      assert.ok(refreshed.notes?.some(note => note.includes("2 of 6 shots added or retained")), "Report the combined total of one new stock shot and one retained card");
      assert.equal((await jobs()).find(job => job.id === parent.id)?.auto?.brollCount, undefined, "Target changes only the new revision");
      const after = await planOf(refreshed.id);
      assert.equal((await jobs()).length, count + 1);
      assert.deepEqual(after.cuts, before.cuts);
      assert.deepEqual(after.captions, captions);
      assert.equal(after.audioMediaId, before.audioMediaId);
      assert.equal(after.narration, true);
      assert.deepEqual(after.settings, before.settings);
      assert.equal(after.visuals.length, 2, JSON.stringify(refreshed.notes));
      assert.deepEqual(after.visuals.find(item => item.mediaId === cardId), cardPlacement);
      const keptCard = after.media.find(item => item.id === cardId)!;
      assert.equal(keptCard.visualSource, "remotion");
      assert.equal(keptCard.name, "Saved Remotion title");
      assert.equal(digest(await download(keptCard.url!)), digest(cardBytes));
      assert.equal(refreshed.supportingVisuals?.find(item => item.kind === "graphic")?.visualSource, "remotion");
      const stockPlacement = after.visuals.find(item => item.mediaId !== cardId)!;
      assert.equal(stockPlacement.start, 4);
      assert.equal(stockPlacement.locked, true);
      const shot = after.media.find(item => item.id === stockPlacement.mediaId)!;
      assert.equal(shot.stock?.providerId, "pixabay:456123");
      assert.equal(digest(await download(shot.url!)), digest(sourceBytes));
      assert.deepEqual(await planOf(parent.id), before, "Refresh preserves its parent plan and snapshots");
      assert.equal(digest(await download(original.downloadUrl!)), digest(originalBytes));
      const requests = await readFile(requestLog, "utf8");
      assert.match(requests, /sunset/iu);
      assert.doesNotMatch(requests, /mountain|snow|hiking/iu);
      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(persisted.jobs.find((item: RenderJob) => item.id === refreshed.id).refreshBroll, undefined);
      await stop();
      await start(true);
      assert.deepEqual(await planOf(refreshed.id), after);
      const textOnly = await request(`/api/jobs/${refreshed.id}/revisions`, "POST", { revision: after.revision, hookText: "A saved seaside moment" });
      assert.equal(textOnly.status, 201);
      const textJob = await completed((await textOnly.json() as RenderJob).id);
      assert.equal(textJob.auto?.brollCount, 6, "Text corrections preserve the saved target");
      const textPlan = await planOf(textJob.id);
      assert.deepEqual(textPlan.visuals, after.visuals);
      assert.equal(textPlan.audioMediaId, after.audioMediaId);
      assert.equal(await readFile(requestLog, "utf8"), requests, "Caption/hook corrections never invoke a stock provider");
      // A failed fresh query retains the previous working shot.
      await writeFile(emptyFlag, "");
      const noMatch = await request(`/api/jobs/${textJob.id}/revisions`, "POST", {
        revision: textPlan.revision, refreshBroll: true,
        captions: [{ id: "saved-speech", start: 4, end: 6.5, text: "Desert dunes wind." }],
      });
      assert.equal(noMatch.status, 201);
      const noMatchJob = await completed((await noMatch.json() as RenderJob).id);
      assert.deepEqual((await planOf(noMatchJob.id)).visuals, textPlan.visuals);
      assert.ok(noMatchJob.notes?.some(note => note.includes("saved supporting shots were kept")));
      assert.ok(!noMatchJob.notes?.some(note => note.includes("Original footage was kept")), "A kept stock shot must not be described as original source footage");

      const { transcriptFromPlan } = await import("../server/plan-storage.js");
      const fallback = structuredClone(parent);
      fallback.editPlan.captions = [];
      assert.equal(transcriptFromPlan(fallback), undefined, "Original speech cannot stand in for uncaptained rewritten narration");
      fallback.editPlan.narration = false;
      fallback.editPlan.cuts = [{ start: 4, end: 8 }];
      fallback.editPlan.settings.speed = 2;
      fallback.editPlan.outputDuration = 2;
      fallback.sourceTranscript.segments = [{ start: 4.5, end: 6, text: "Mountain snow hiking.", words: [
        { start: 4.5, end: 5, word: "Mountain", probability: 1 },
        { start: 5, end: 5.5, word: "snow", probability: 1 },
        { start: 5.5, end: 6, word: "hiking.", probability: 1 },
      ] }];
      const retimed = transcriptFromPlan(fallback)!;
      assert.equal(retimed.duration, 2);
      assert.equal(retimed.segments[0]!.start, 0.25);
      assert.equal(retimed.segments[0]!.end, 1);
      assert.equal(retimed.segments[0]!.words[1]!.start, 0.5);
    });
    await t.test("uploaded insertions remain editable after deleting their library item and restarting", async () => {
      const asset = ((await upload("/api/broll", brollPath, "My extra footage.mp4")) as { assets: BrollAsset[] }).assets[0]!;
      const ownFootage = [{ id: randomUUID(), assetId: asset.id, mode: "insert", at: 2, start: 0, end: 1, audio: "clip", fit: "contain" }];
      const invalid = await request(`/api/jobs/${original.id}/revisions`, "POST", { revision: plan.revision, ownFootage: [{ ...ownFootage[0], assetId: randomUUID() }] });
      assert.equal(invalid.status, 400);
      const response = await request(`/api/jobs/${original.id}/revisions`, "POST", { revision: plan.revision, ownFootage });
      assert.equal(response.status, 201, await response.clone().text());
      const inserted = await completed((await response.json() as RenderJob).id);
      assertPublic(inserted);
      assert.equal(inserted.summary!.outputDuration, plan.outputDuration + 1);
      assert.equal(inserted.qualityReport?.issues.some(issue => issue.code === "duration-mismatch"), false);
      assert.equal(inserted.footageAssets?.[0]?.name, "My extra footage.mp4");
      const snapshot = await download(inserted.footageAssets![0]!.url);
      assert.equal(digest(snapshot), digest(await readFile(brollPath)));
      assert.equal((await request(`/api/broll/${asset.id}`, "DELETE")).status, 200);
      await stop(); await start(true);
      const saved = await planOf(inserted.id);
      assert.deepEqual(saved.settings.ownFootage, ownFootage);
      const revised = await request(`/api/jobs/${inserted.id}/revisions`, "POST", { revision: saved.revision, hookText: "My saved footage remains" });
      assert.equal(revised.status, 201, await revised.clone().text());
      const completedRevision = await completed((await revised.json() as RenderJob).id);
      assert.equal(completedRevision.summary!.outputDuration, inserted.summary!.outputDuration);
      assert.equal(digest(await download(completedRevision.footageAssets![0]!.url)), digest(snapshot));
      assert.deepEqual((await planOf(completedRevision.id)).settings.ownFootage, ownFootage);
      assert.equal(digest(await download(original.downloadUrl!)), digest(originalBytes));
    });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
