import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { BrollAsset, EditPlan, ExportHistoryEntry, RenderJob, VideoSource } from "../shared/types.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

// The ledger and repeat decisions use real uploads, HTTP, persisted state and
// FFmpeg. Cloud APIs and local speech/intelligence models remain disabled.
test("export history survives new batches, renamed reuploads, deletion and expiry", { timeout: 150000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-history-api-"));
  const dataDirectory = path.join(directory, "workspace");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let processLog = "";
  const request = (url: string, method: string, body?: unknown) => fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const jobs = async () => ((await (await fetch(`${base}/api/jobs`)).json()) as { jobs: RenderJob[] }).jobs;
  const history = async (sourceId?: string) => {
    const response = await fetch(`${base}${sourceId ? `/api/sources/${sourceId}/history` : "/api/history"}`);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { entries: ExportHistoryEntry[] };
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(directory));
    for (const field of ["filePath", "outputPath", "planFiles", "captionPath", "thumbnailPath", "apiKey"])
      assert.ok(!serialized.includes(`"${field}"`), `History must not expose ${field}`);
    return result.entries;
  };
  const thumbnailBytes = async (entry: ExportHistoryEntry, kind: "export" | "source" = "export") => {
    assert.equal(entry.thumbnailUrl, `/api/history/${encodeURIComponent(entry.id)}/thumbnail`);
    assert.equal(entry.thumbnailKind, kind);
    const response = await fetch(`${base}${entry.thumbnailUrl}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get("content-type") || "", /^image\/jpeg(?:;|$)/u);
    assert.match(response.headers.get("cache-control") || "", /private/u);
    const image = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff], "The endpoint returns JPEG bytes, not a video or JSON response");
    assert.deepEqual([...image.subarray(-2)], [0xff, 0xd9]);
    assert.ok(image.length > 100 && image.length < 512 * 1024, "History keeps a small preview rather than the original media");
    return image;
  };
  const retainedThumbnails = new Map<string, Buffer>();
  const retainedKinds = new Map<string, "export" | "source">();
  let expectedHistoryCount = 1;
  let expectedSourceExports = 1;
  const reuseNotice = (job: RenderJob) => assert.ok(job.notes?.includes(
    "This edit reuses footage from an earlier export. Open History to compare."), "Reused source footage is explained without preventing the export");
  const clearLegacyThumbnails = async () => {
    const statePath = path.join(dataDirectory, "state.json");
    const saved = JSON.parse(await readFile(statePath, "utf8")) as { history: ExportHistoryEntry[] };
    for (const entry of saved.history) {
      delete entry.thumbnailUrl;
      delete entry.thumbnailKind;
    }
    await rm(path.join(dataDirectory, "history-thumbnails"), { recursive: true, force: true });
    await writeFile(statePath, JSON.stringify(saved));
  };
  const start = async () => {
    processLog = "";
    server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDirectory,
        RENDER_CONCURRENCY: "2", AUTO_AI: "false", RETENTION_HOURS: "1",
        WHISPER_CACHE_DIR: path.join(directory, "model-not-installed"),
        DEEPSEEK_API_KEY: "", PIXABAY_API_KEY: "", MAX_FILES: "8", MAX_FILE_SIZE_MB: "3",
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
    throw new Error(`History test server did not start: ${processLog}`);
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
  const finished = async (id: string, expected: "completed" | "skipped") => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const job = (await jobs()).find((item) => item.id === id);
      if (job && !["queued", "processing"].includes(job.status)) {
        assert.equal(job.status, expected, `${JSON.stringify(job)}\n${processLog}`);
        return job;
      }
      await sleep(100);
    }
    throw new Error(`History render timed out: ${processLog}`);
  };
  const upload = async (endpoint: string, file: string, filename: string) => {
    const form = new FormData();
    form.append("videos", new Blob([await readFile(file)]), filename);
    const response = await fetch(`${base}${endpoint}`, { method: "POST", body: form });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const sourceUpload = async (file: string, filename: string) =>
    ((await upload("/api/sources", file, filename)) as { sources: VideoSource[] }).sources[0]!;
  const auto = async (sourceId: string, brollId?: string) => {
    const response = await request("/api/auto/jobs", "POST", {
      sourceIds: [sourceId], variants: 1,
      options: { aspect: "16:9", targetDuration: 30, narration: false,
        ...(brollId ? { supportingVisuals: "library", brollMatching: "tags", brollIds: [brollId] } : {}) },
    });
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as { jobs: RenderJob[] }).jobs[0]!;
  };
  try {
    const sourcePath = path.join(directory, "source.mp4");
    const changedPath = path.join(directory, "different.mp4");
    const brollPath = path.join(directory, "broll.mp4");
    for (const [output, filter, frequency, duration] of [
      [sourcePath, "testsrc2=size=320x180:rate=24", 440, 12],
      [changedPath, "testsrc2=size=320x180:rate=24", 880, 12],
      [brollPath, "color=red:size=320x180:rate=24", 440, 3],
    ] as const) await exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", filter,
      "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`,
      "-t", String(duration), "-c:v", "libx264", "-threads", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", output,
    ]);
    await start();
    assert.deepEqual(await history(), []);
    const source = await sourceUpload(sourcePath, "sunset coast.mp4");
    assert.ok(source.fingerprint);
    assert.equal(source.previousExports, 0);
    assert.deepEqual(await history(source.id), []);
    const asset = ((await upload("/api/broll", brollPath, "sunset sea.mp4")) as { assets: BrollAsset[] }).assets[0]!;
    const original = await finished((await auto(source.id, asset.id)).id, "completed");
    const initialHistory = await history();
    assert.equal(initialHistory.length, 1);
    const entry = initialHistory[0]!;
    assert.equal(entry.jobId, original.id);
    assert.equal(entry.sourceId, source.id);
    assert.equal(entry.sourceFingerprint, source.fingerprint);
    assert.equal(entry.sourceName, source.name);
    assert.deepEqual(entry.cuts, original.settings.segments);
    assert.equal(typeof entry.sourceText, "string");
    assert.ok(Math.abs(entry.outputDuration - original.summary!.outputDuration) < 0.01);
    assert.equal(entry.available, true);
    assert.equal(entry.revision, 1);
    assert.deepEqual(entry.publications, []);
    assert.equal(original.supportingVisuals!.length, 1);
    assert.equal(entry.stockShots.length, 1);
    assert.equal(entry.stockShots[0]!.identity, `library:${asset.id}`);
    assert.equal(entry.stockShots[0]!.name, asset.name);
    assert.equal(entry.stockShots[0]!.sourceStart, original.supportingVisuals![0]!.sourceStart ?? 0);
    assert.ok(Math.abs(entry.stockShots[0]!.duration -
      (original.supportingVisuals![0]!.end - original.supportingVisuals![0]!.start)) < 0.01);
    assert.deepEqual(await history(source.id), initialHistory);

    await t.test("completed exports expose a small retained JPEG and unknown or traversal IDs cannot retrieve files", async () => {
      const image = await thumbnailBytes(entry);
      retainedThumbnails.set(entry.id, image);
      const preview = path.join(directory, "history-preview.jpg");
      await writeFile(preview, image);
      const inspected = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", preview]);
      const frame = JSON.parse(inspected.stdout).streams[0];
      assert.equal(frame.codec_name, "mjpeg");
      assert.ok(frame.width <= 480 && frame.height <= 480);
      assert.ok(Math.abs(frame.width / frame.height - 16 / 9) < 0.02);
      for (const id of [randomUUID(), "..%2Fstate.json", "%2E%2E%5Cstate.json", "%2Fetc%2Fpasswd"])
        assert.equal((await fetch(`${base}/api/history/${id}/thumbnail`)).status, 404);
    });

    await t.test("fresh batches render previously exported footage with requested B-roll and explicit corrections remain renderable", async () => {
      const fresh = await auto(source.id, asset.id);
      assert.notEqual(fresh.batchId, original.batchId);
      const repeated = await finished(fresh.id, "completed");
      reuseNotice(repeated);
      assert.ok(repeated.downloadUrl);
      assert.equal(repeated.supportingVisuals?.filter(item => item.kind === "broll").length, 1,
        "History cannot skip planning or discard the B-roll requested for a new export");
      assert.equal(repeated.supportingVisuals?.find(item => item.kind === "broll")?.assetId, asset.id);
      expectedHistoryCount++; expectedSourceExports++;
      const repeatedEntry = (await history()).find(item => item.jobId === repeated.id)!;
      retainedThumbnails.set(repeatedEntry.id, await thumbnailBytes(repeatedEntry));
      assert.equal((await history()).length, expectedHistoryCount);
      const planResponse = await fetch(`${base}/api/jobs/${original.id}/plan`);
      assert.equal(planResponse.status, 200);
      const plan = await planResponse.json() as EditPlan;
      const correction = await request(`/api/jobs/${original.id}/revisions`, "POST", {
        revision: plan.revision, hookText: "A clearer view of the coast", correctionSeconds: 45,
      });
      assert.equal(correction.status, 201, await correction.clone().text());
      const revised = await finished((await correction.json() as RenderJob).id, "completed");
      const revisedEntry = (await history()).find((item) => item.jobId === revised.id)!;
      assert.ok(revisedEntry);
      assert.equal(revisedEntry.parentJobId, original.id);
      assert.equal(revisedEntry.revision, 2);
      assert.equal(revisedEntry.sourceFingerprint, entry.sourceFingerprint);
      assert.deepEqual(revisedEntry.stockShots, entry.stockShots);
      assert.deepEqual(revisedEntry.cuts, entry.cuts);
      assert.deepEqual(revisedEntry.corrections, { captionCorrections: 0, brollChanges: 0, seconds: 45 });
      const revisedThumbnail = await thumbnailBytes(revisedEntry);
      assert.notDeepEqual(revisedThumbnail, retainedThumbnails.get(entry.id),
        "A changed rendered hook must change the preview instead of reusing the source thumbnail");
      retainedThumbnails.set(revisedEntry.id, revisedThumbnail);
      expectedHistoryCount++; expectedSourceExports++;
      assert.equal((await history()).length, expectedHistoryCount);
    });

    let renamed!: VideoSource;
    let different!: RenderJob;
    await t.test("renaming identical bytes retains history and changed content avoids a false source match", async () => {
      renamed = await sourceUpload(sourcePath, "a completely different filename.mp4");
      assert.notEqual(renamed.id, source.id);
      assert.equal(renamed.fingerprint, source.fingerprint);
      assert.equal(renamed.previousExports, expectedSourceExports);
      assert.equal((await history(renamed.id)).length, expectedSourceExports);
      const regenerated = await finished((await auto(renamed.id)).id, "completed");
      reuseNotice(regenerated);
      expectedHistoryCount++; expectedSourceExports++;
      const regeneratedEntry = (await history()).find(item => item.jobId === regenerated.id)!;
      retainedThumbnails.set(regeneratedEntry.id, await thumbnailBytes(regeneratedEntry));
      assert.equal((await history()).length, expectedHistoryCount);
      const changed = await sourceUpload(changedPath, source.name);
      assert.notEqual(changed.fingerprint, source.fingerprint);
      assert.equal(changed.previousExports, 0);
      assert.deepEqual(await history(changed.id), []);
      different = await finished((await auto(changed.id)).id, "completed");
      const differentEntry = (await history()).find(item => item.jobId === different.id)!;
      retainedThumbnails.set(differentEntry.id, await thumbnailBytes(differentEntry));
      expectedHistoryCount++;
      assert.equal((await history(changed.id)).length, 1);
      assert.equal((await history()).length, expectedHistoryCount);
    });

    const publications: ExportHistoryEntry["publications"] = [
      { platform: "instagram", publishedAt: new Date(Date.now() - 60000).toISOString(), url: "https://www.instagram.com/reel/history-fixture/" },
      { platform: "tiktok", publishedAt: new Date(Date.now() - 30000).toISOString(), url: "https://www.tiktok.com/@creator/video/1234567890" },
    ];
    await t.test("publication updates validate timestamps and platform URLs without corrupting export history", async () => {
      assert.equal((await request(`/api/history/${randomUUID()}`, "PATCH", { publications: [] })).status, 404);
      for (const invalid of [
        { publications: [{ platform: "youtube", publishedAt: publications[0]!.publishedAt }] },
        { publications: [{ ...publications[0], publishedAt: "not-a-date" }] },
        { publications: [{ ...publications[0], url: "https://www.tiktok.com/@creator/video/1234567890" }] },
        { publications: [{ ...publications[0], url: "https://instagram.com.example.org/reel/123" }] },
        { publications: [{ ...publications[0], url: "file:///etc/passwd" }] },
        { publications, sourceFingerprint: "replace-source" },
      ]) {
        const rejected = await request(`/api/history/${entry.id}`, "PATCH", invalid);
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.deepEqual((await history()).find((item) => item.id === entry.id)!.publications, []);
      }
      const published = await request(`/api/history/${entry.id}`, "PATCH", { publications });
      assert.equal(published.status, 200, await published.clone().text());
      const updated = await published.json() as ExportHistoryEntry;
      assert.deepEqual(updated.publications, publications);
      assert.deepEqual(updated.cuts, entry.cuts);
      assert.deepEqual(updated.stockShots, entry.stockShots);
      assert.equal(updated.sourceFingerprint, entry.sourceFingerprint);
    });

    const measurements = {
      review: { verdict: "rejected", issueReasons: ["ending"], benchmarkCase: "editorial-work-shutdown", approach: "Comparison", openingClear: true, endingComplete: false,
        brollReviewed: 2, brollAccepted: 1, captionCorrections: 3, correctionSeconds: 95, notes: "The ending needs its final example." },
      posts: [
        { platform: "instagram", measuredAt: "2026-09-15T10:00:00.000Z", views: 100, averageWatchSeconds: 5, completionPercent: 50, saves: 1, shares: 2 },
        { platform: "instagram", measuredAt: "2026-09-15T11:00:00.000Z", views: 200, averageWatchSeconds: 8, completionPercent: 75, saves: 3, shares: 4, platformNotice: "Synthetic fixture: platform review notice" },
      ],
    };
    await t.test("review results validate, aggregate latest observations and survive startup reconciliation", async () => {
      for (const invalid of [
        { review: { verdict: "approved" } },
        { review: { verdict: "rejected", issueReasons: ["meaning", "meaning"] } },
        { review: { issueReasons: ["unsupported"] } },
        { review: { brollReviewed: 1, brollAccepted: 2 } },
        { review: { correctionSeconds: -2 } },
        { posts: [{ platform: "tiktok", measuredAt: "invalid" }] },
        { posts: [{ platform: "instagram", measuredAt: new Date().toISOString(), completionPercent: 101 }] },
        { ...measurements, sourceFingerprint: "overwrite" },
      ]) {
        const rejected = await request(`/api/history/${entry.id}/measurements`, "PATCH", invalid);
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.equal((await history()).find(item => item.id === entry.id)!.measurements, undefined);
      }
      const jobsBeforeReview = (await jobs()).map(job => job.id).sort();
      const accepted = await request(`/api/history/${entry.id}/measurements`, "PATCH", { review: { verdict: "accepted-unchanged" } });
      assert.equal(accepted.status, 200, await accepted.clone().text());
      const acceptedEntry = await accepted.json() as ExportHistoryEntry;
      assert.deepEqual(acceptedEntry.measurements, { review: { verdict: "accepted-unchanged" } });
      assert.equal(acceptedEntry.revision, entry.revision);
      assert.deepEqual((await jobs()).map(job => job.id).sort(), jobsBeforeReview, "A human verdict never creates a render or revision");
      const acceptedSummary = await (await fetch(`${base}/api/measurements`)).json();
      assert.equal(acceptedSummary.totals.acceptedUnchanged, 1);
      assert.equal(acceptedSummary.totals.acceptanceRate, 1);
      const response = await request(`/api/history/${entry.id}/measurements`, "PATCH", measurements);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await response.json() as ExportHistoryEntry).measurements, measurements);
      const summary = await (await fetch(`${base}/api/measurements`)).json();
      const group = summary.groups.find((item: { approach: string }) => item.approach === "Comparison");
      assert.equal(group.exports, 1);
      assert.equal(group.verdictReviews, 1);
      assert.equal(group.rejected, 1);
      assert.equal(group.acceptanceRate, 0);
      assert.equal(group.unchangedAcceptanceRate, 0);
      assert.equal(group.brollAcceptanceRate, 0.5);
      assert.equal(group.totalViews, 200, "Metric snapshots do not double-count cumulative post views");
      assert.equal(group.averageWatchSeconds, 8);
      assert.equal(group.completionPercent, 75);
      assert.equal(group.averageCorrectionSeconds, 95);
      assert.equal(group.medianCorrectionSeconds, 95);
      const csv = await fetch(`${base}/api/measurements/export?format=csv`);
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-disposition") || "", /attachment/u);
      assert.match(await csv.text(), /Comparison/u);
      const exported = await (await fetch(`${base}/api/measurements/export?format=json`)).json();
      assert.equal(exported.version, 1);
      assert.equal(exported.totals.rejected, 1);
      assert.deepEqual(exported.entries.find((item: ExportHistoryEntry) => item.id === entry.id).measurements, measurements);
      assert.ok(!JSON.stringify(exported).includes(dataDirectory));
      assert.equal((await fetch(`${base}/api/measurements/export?format=xml`)).status, 400);
      await stop();
      await start();
      assert.deepEqual((await history()).find(item => item.id === entry.id)!.measurements, measurements);
    });

    await t.test("startup backfills legacy history previews from available exports without changing reviews or publications", async () => {
      await stop();
      await clearLegacyThumbnails();
      await start();
      const restored = await history();
      assert.equal(restored.length, expectedHistoryCount);
      for (const item of restored)
        assert.deepEqual(await thumbnailBytes(item), retainedThumbnails.get(item.id), "Backfill captures the same completed export frame");
      const reviewed = restored.find(item => item.id === entry.id)!;
      assert.deepEqual(reviewed.measurements, measurements);
      assert.deepEqual(reviewed.publications, publications);
    });

    await t.test("deleting exports removes media while retaining the ledger and publication record", async () => {
      assert.equal((await request(`/api/batches/${original.batchId}`, "DELETE")).status, 200);
      assert.equal((await fetch(`${base}${original.downloadUrl}`)).status, 404);
      await assert.rejects(stat(path.join(dataDirectory, "plans", original.id)), { code: "ENOENT" });
      const retained = (await history()).find((item) => item.id === entry.id)!;
      assert.ok(retained);
      assert.equal(retained.available, false);
      assert.deepEqual(retained.cuts, entry.cuts);
      assert.deepEqual(retained.stockShots, entry.stockShots);
      assert.deepEqual(retained.publications, publications);
      assert.deepEqual(retained.measurements, measurements);
      assert.equal(retained.sourceText, entry.sourceText);
      assert.deepEqual(await thumbnailBytes(retained), retainedThumbnails.get(entry.id));
      assert.equal((await history(renamed.id)).length, expectedSourceExports);
      assert.equal((await history()).length, expectedHistoryCount);
      assert.equal((await request(`/api/sources/${source.id}`, "DELETE")).status, 200);
      await stop();
      await start();
      assert.deepEqual((await history()).find((item) => item.id === entry.id), retained);
      assert.deepEqual(await thumbnailBytes(retained), retainedThumbnails.get(entry.id), "Deleting the source and restarting cannot remove the retained preview");
      const reimport = await sourceUpload(sourcePath, "yesterdays source again.mp4");
      assert.equal(reimport.previousExports, expectedSourceExports);
      assert.deepEqual((await history(reimport.id)).find((item) => item.id === entry.id), retained);
      const regenerated = await finished((await auto(reimport.id)).id, "completed");
      reuseNotice(regenerated);
      expectedHistoryCount++; expectedSourceExports++;
      const regeneratedEntry = (await history()).find(item => item.jobId === regenerated.id)!;
      retainedThumbnails.set(regeneratedEntry.id, await thumbnailBytes(regeneratedEntry));
      assert.equal((await history()).length, expectedHistoryCount);
    });

    await t.test("legacy deleted-export previews fall back to the matching reuploaded source and are labeled as source frames", async () => {
      await stop();
      await clearLegacyThumbnails();
      await start();
      const restored = await history();
      assert.equal(restored.length, expectedHistoryCount);
      for (const item of restored) {
        const kind = item.available ? "export" : "source";
        retainedThumbnails.set(item.id, await thumbnailBytes(item, kind));
        retainedKinds.set(item.id, kind);
      }
      const reviewed = restored.find(item => item.id === entry.id)!;
      assert.equal(reviewed.available, false);
      assert.equal(reviewed.sourceId, source.id, "Source fallback does not rewrite the original source identity");
      assert.deepEqual(reviewed.cuts, entry.cuts);
      assert.deepEqual(reviewed.measurements, measurements);
      assert.deepEqual(reviewed.publications, publications);
    });

    await t.test("normal retention cleanup expires jobs and source files while preserving reusable history", async () => {
      await stop();
      const statePath = path.join(dataDirectory, "state.json");
      const saved = JSON.parse(await readFile(statePath, "utf8")) as { jobs: RenderJob[]; sources: VideoSource[] };
      // Age only the isolated fixture's temporary exports and sources. Startup
      // invokes the production expiry path; the history ledger is untouched.
      const old = "2000-01-01T00:00:00.000Z";
      for (const job of saved.jobs) { job.createdAt = old; job.finishedAt = old; }
      for (const source of saved.sources) source.createdAt = old;
      await writeFile(statePath, JSON.stringify(saved));
      await start();
      assert.deepEqual(await jobs(), []);
      assert.deepEqual(await readdir(path.join(dataDirectory, "outputs")), []);
      assert.deepEqual(await readdir(path.join(dataDirectory, "plans")), []);
      assert.equal((await fetch(`${base}${different.downloadUrl}`)).status, 404);
      const retained = await history();
      assert.equal(retained.length, expectedHistoryCount);
      assert.ok(retained.every((item) => item.available === false));
      assert.deepEqual(retained.find((item) => item.id === entry.id)!.publications, publications);
      assert.deepEqual(retained.find((item) => item.id === entry.id)!.measurements, measurements);
      for (const item of retained)
        assert.deepEqual(await thumbnailBytes(item, retainedKinds.get(item.id)!), retainedThumbnails.get(item.id),
          "Retention removes full media but preserves every retained history preview");
      const reimport = await sourceUpload(sourcePath, "after all media expired.mp4");
      assert.equal(reimport.fingerprint, source.fingerprint);
      assert.equal(reimport.previousExports, expectedSourceExports);
      assert.equal((await history(reimport.id)).length, expectedSourceExports);
      const regenerated = await finished((await auto(reimport.id)).id, "completed");
      reuseNotice(regenerated);
      expectedHistoryCount++; expectedSourceExports++;
      const regeneratedEntry = (await history()).find(item => item.jobId === regenerated.id)!;
      retainedThumbnails.set(regeneratedEntry.id, await thumbnailBytes(regeneratedEntry));
      assert.equal((await history()).length, expectedHistoryCount);
    });

    await t.test("legacy history without a remaining export or matching source leaves the preview absent", async () => {
      await stop();
      await clearLegacyThumbnails();
      await start();
      const restored = await history();
      const missing = restored.find(item => item.jobId === different.id)!;
      assert.equal(missing.available, false);
      assert.equal(missing.thumbnailUrl, undefined);
      assert.equal(missing.thumbnailKind, undefined);
      assert.equal((await fetch(`${base}/api/history/${missing.id}/thumbnail`)).status, 404);
      assert.equal(restored.length, expectedHistoryCount, "A missing preview never removes the history record");
      const reviewed = restored.find(item => item.id === entry.id)!;
      await thumbnailBytes(reviewed, "source");
      assert.deepEqual(reviewed.measurements, measurements);
      assert.deepEqual(reviewed.publications, publications);
    });

    let concurrentSource!: VideoSource;
    await t.test("concurrent uploads with identical fingerprints both render and explain reuse after serialized analysis", async () => {
      const freshPath = path.join(directory, "fresh-for-concurrency.mp4");
      await exec("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=12",
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=12",
        "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", freshPath,
      ]);
      const first = await sourceUpload(freshPath, "fresh sunset coast.mp4");
      concurrentSource = first;
      const second = await sourceUpload(freshPath, "fresh sunset coast duplicate.mp4");
      assert.notEqual(first.id, second.id);
      assert.equal(first.fingerprint, second.fingerprint);
      assert.equal(first.previousExports, 0);
      assert.equal(second.previousExports, 0);
      const created = await request("/api/auto/jobs", "POST", {
        sourceIds: [first.id, second.id], variants: 1,
        options: { aspect: "16:9", targetDuration: 30, narration: false },
      });
      assert.equal(created.status, 201, await created.clone().text());
      const queued = (await created.json() as { jobs: RenderJob[] }).jobs;
      assert.equal(queued.length, 2);
      const ids = new Set(queued.map((job) => job.id));
      const deadline = Date.now() + 60000;
      let complete: RenderJob[] = [];
      let current: RenderJob[] = [];
      while (Date.now() < deadline) {
        current = (await jobs()).filter((job) => ids.has(job.id));
        assert.equal(current.length, 2, "Both concurrent jobs must remain in the queue");
        assert.ok(current.filter((job) => job.status === "processing").length <= 1,
          "The two-slot queue must serialize equivalent source content across different source IDs");
        if (current.every((job) => !["queued", "processing"].includes(job.status))) {
          complete = current;
          break;
        }
        await sleep(50);
      }
      assert.deepEqual(complete.map((job) => job.status).sort(), ["completed", "completed"],
        `Duplicate-import jobs did not finish: ${JSON.stringify(current)}\n${processLog}`);
      reuseNotice(complete.find(job => job.id === queued[1]!.id)!);
      expectedHistoryCount += 2;
      assert.equal((await history(first.id)).length, 2);
      assert.equal((await history(second.id)).length, 2);
      assert.equal((await history()).length, expectedHistoryCount);
    });

    await t.test("a skipped within-batch alternative can explicitly generate anyway with requested B-roll", async () => {
      const created = await request("/api/auto/jobs", "POST", {
        sourceIds: [concurrentSource.id], variants: 2,
        options: { aspect: "16:9", targetDuration: 30, narration: false,
          supportingVisuals: "library", brollMatching: "tags", brollIds: [asset.id] },
      });
      assert.equal(created.status, 201, await created.clone().text());
      const queued = (await created.json() as { jobs: RenderJob[] }).jobs;
      assert.equal(queued.length, 2);
      await finished(queued[0]!.id, "completed");
      const skipped = await finished(queued[1]!.id, "skipped");
      assert.match(skipped.notes?.join(" ") || "", /this batch|Generate anyway/iu);
      expectedHistoryCount++;
      assert.equal((await history()).length, expectedHistoryCount, "The skipped suggestion creates no export history entry");
      const retried = await request(`/api/jobs/${skipped.id}/retry`, "POST");
      assert.equal(retried.status, 200, await retried.clone().text());
      const regenerated = await finished(skipped.id, "completed");
      reuseNotice(regenerated);
      assert.ok(regenerated.downloadUrl);
      assert.equal(regenerated.supportingVisuals?.filter(item => item.kind === "broll").length, 1);
      assert.equal(regenerated.supportingVisuals?.find(item => item.kind === "broll")?.assetId, asset.id);
      expectedHistoryCount++;
      assert.equal((await history()).length, expectedHistoryCount);
      assert.equal((await history()).filter(item => item.jobId === regenerated.id).length, 1);
      assert.equal((await request(`/api/jobs/${regenerated.id}/retry`, "POST")).status, 409, "Completed exports retain the existing retry guard");
    });
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
