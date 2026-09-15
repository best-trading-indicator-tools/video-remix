import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { BrollAsset, RenderJob, VideoSource } from "../shared/types.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

test(
  "B-roll API persists tagged assets, protects active references, and renders selected visuals with source audio",
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "remix-broll-api-"));
    const dataDirectory = path.join(directory, "workspace");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let server: ChildProcess | undefined;
    let processLog = "";
    const request = (url: string, method: string, body?: unknown) =>
      fetch(`${base}${url}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
    const assets = async (): Promise<BrollAsset[]> =>
      (
        (await (await fetch(`${base}/api/broll`)).json()) as {
          assets: BrollAsset[];
        }
      ).assets;
    const jobs = async (): Promise<RenderJob[]> =>
      (
        (await (await fetch(`${base}/api/jobs`)).json()) as {
          jobs: RenderJob[];
        }
      ).jobs;
    const assertPublic = (value: unknown) => {
      const text = JSON.stringify(value);
      assert.equal(
        text.includes(dataDirectory),
        false,
        "Public responses omit local storage paths",
      );
      for (const field of [
        "filePath",
        "thumbnailPath",
        "outputPath",
        "captionPath",
      ])
        assert.equal(text.includes(`"${field}"`), false);
    };
    const start = async () => {
      server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          DATA_DIR: dataDirectory,
          RENDER_CONCURRENCY: "1",
          AUTO_LOCAL_AI: "false",
          WHISPER_CACHE_DIR: path.join(directory, "model-not-installed"),
          MAX_FILES: "4",
          MAX_FILE_SIZE_MB: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const output of [server.stdout, server.stderr])
        output?.on("data", (chunk) => {
          processLog = (processLog + chunk.toString()).slice(-16000);
        });
      let lastFetchError: unknown;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          // Each restart owns a fresh listener at the same address. Readiness
          // probes should not reuse a pooled socket from the stopped process.
          const response = await fetch(`${base}/api/health`, {
            headers: { Connection: "close" },
            signal: AbortSignal.timeout(2000),
          });
          await response.arrayBuffer();
          if (response.ok) return;
        } catch (error) {
          lastFetchError = error;
        }
        if (server.exitCode !== null || server.signalCode !== null)
          throw new Error(
            `B-roll server exited during startup (pid=${server.pid}, code=${server.exitCode}, signal=${server.signalCode}): ${processLog}`,
            { cause: lastFetchError },
          );
        await sleep(100);
      }
      throw new Error(
        `B-roll test server did not start (pid=${server.pid}): ${processLog}`,
        { cause: lastFetchError },
      );
    };
    const stop = async () => {
      if (!server || server.exitCode !== null || server.signalCode !== null)
        return;
      const child = server;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    };
    const waitForCompletion = async (id: string): Promise<RenderJob> => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const job = (await jobs()).find((item) => item.id === id);
        if (job?.status === "completed") return job;
        if (job && !["queued", "processing"].includes(job.status))
          throw new Error(
            `B-roll render did not complete: ${JSON.stringify(job)}\n${processLog}`,
          );
        await sleep(100);
      }
      throw new Error(`B-roll render timed out: ${processLog}`);
    };
    try {
      const sourceFile = path.join(directory, "source.mp4");
      const brollFile = path.join(directory, "broll.mp4");
      for (const [output, color, frequency, duration] of [
        [sourceFile, "blue", 440, 12],
        [brollFile, "red", 990, 3],
      ] as const)
        await exec("ffmpeg", [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:size=640x360:rate=30:duration=${duration}`,
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
          "-c:v",
          "libx264",
          "-threads",
          "2",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          output,
        ]);
      await start();
      assert.deepEqual(await assets(), []);

      const form = new FormData();
      form.append(
        "videos",
        new Blob([await readFile(brollFile)]),
        "camera001.mp4",
      );
      form.append("videos", new Blob(["This is not a video"]), "broken.mp4");
      const uploaded = await fetch(`${base}/api/broll`, {
        method: "POST",
        body: form,
      });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const libraryUpload = (await uploaded.json()) as {
        assets: BrollAsset[];
        errors: { name: string; error: string }[];
      };
      assert.equal(libraryUpload.assets.length, 1);
      assert.equal(libraryUpload.errors.length, 1);
      assert.equal(libraryUpload.errors[0]!.name, "broken.mp4");
      assertPublic(libraryUpload);
      const asset = libraryUpload.assets[0]!;
      assert.equal(asset.name, "camera001.mp4");
      assert.deepEqual(asset.tags, []);
      assert.equal(
        (await readdir(path.join(dataDirectory, "uploads"))).length,
        1,
        "Invalid library uploads are removed",
      );

      for (const invalid of [
        { tags: [""] },
        { tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`) },
        { tags: ["valid"], filePath: "/not-allowed" },
      ])
        assert.equal(
          (await request(`/api/broll/${asset.id}`, "PATCH", invalid)).status,
          400,
        );
      assert.deepEqual((await assets())[0]!.tags, []);
      const tagged = await request(`/api/broll/${asset.id}`, "PATCH", {
        tags: [" sunset ", "sea", "sunset"],
      });
      assert.equal(tagged.status, 200);
      const taggedAsset = (await tagged.json()) as BrollAsset;
      assert.deepEqual(taggedAsset.tags, ["sunset", "sea"]);
      assertPublic(taggedAsset);
      assert.equal(
        (
          await request(`/api/broll/${randomUUID()}`, "PATCH", {
            tags: ["sunset"],
          })
        ).status,
        404,
      );

      const ranged = await fetch(`${base}${asset.url}`, {
        headers: { Range: "bytes=0-31" },
      });
      assert.equal(ranged.status, 206);
      assert.match(
        ranged.headers.get("content-range") || "",
        /^bytes 0-31\/\d+$/u,
      );
      assert.equal((await ranged.arrayBuffer()).byteLength, 32);
      assert.equal((await fetch(`${base}${asset.thumbnailUrl}`)).status, 200);

      await stop();
      await start();
      assert.deepEqual(
        await assets(),
        [taggedAsset],
        "Library clips and tags survive restart",
      );
      assertPublic(await assets());

      const sourceForm = new FormData();
      sourceForm.append(
        "videos",
        new Blob([await readFile(sourceFile)]),
        "sunset coast.mp4",
      );
      const sourceResponse = await fetch(`${base}/api/sources`, {
        method: "POST",
        body: sourceForm,
      });
      assert.equal(
        sourceResponse.status,
        201,
        await sourceResponse.clone().text(),
      );
      const source = (
        (await sourceResponse.json()) as { sources: VideoSource[] }
      ).sources[0]!;
      const options = {
        aspect: "16:9",
        targetDuration: 30,
        narration: false,
        supportingVisuals: "library",
      };
      for (const [brollIds, expected] of [
        [["not-a-uuid"], 400],
        [[randomUUID()], 404],
        [[], 400],
      ] as const)
        assert.equal(
          (
            await request("/api/auto/jobs", "POST", {
              sourceIds: [source.id],
              options: { ...options, brollIds },
            })
          ).status,
          expected,
        );
      assert.equal(
        (await jobs()).length,
        0,
        "Invalid library selections enqueue no jobs",
      );

      const created = await request("/api/auto/jobs", "POST", {
        sourceIds: [source.id],
        variants: 1,
        options: { ...options, brollIds: [asset.id, asset.id] },
      });
      assert.equal(created.status, 201, await created.clone().text());
      const batch = (await created.json()) as {
        batchId: string;
        jobs: RenderJob[];
      };
      assert.equal(batch.jobs.length, 1);
      assert.deepEqual(batch.jobs[0]!.auto!.brollIds, [asset.id]);
      const protectedDelete = await request(`/api/broll/${asset.id}`, "DELETE");
      assert.equal(
        protectedDelete.status,
        409,
        await protectedDelete.clone().text(),
      );
      assert.match((await protectedDelete.json()).error, /finish|cancel/iu);

      const job = await waitForCompletion(batch.jobs[0]!.id);
      assertPublic(job);
      assert.equal(job.summary?.usedAI, false);
      assert.equal(job.summary?.transcriptAvailable, false);
      assert.ok(
        job.summary?.changes.some((change) => /B-roll cutaway/u.test(change)),
      );
      assert.equal(job.supportingVisuals?.length, 1);
      const visual = job.supportingVisuals![0]!;
      assert.equal(visual.kind, "broll");
      assert.equal(visual.assetId, asset.id);
      assert.equal(visual.name, "camera001.mp4");
      assert.ok(
        visual.start > 0 && visual.end > visual.start && visual.end < 12,
      );

      const download = await fetch(`${base}${job.downloadUrl}`);
      assert.equal(download.status, 200);
      const output = path.join(directory, "rendered.mp4");
      await writeFile(output, Buffer.from(await download.arrayBuffer()));
      const middle =
        visual.start + Math.min(0.5, (visual.end - visual.start) / 2);
      const pixel = async (time: number) => {
        const { stdout } = await exec(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            String(time),
            "-i",
            output,
            "-an",
            "-frames:v",
            "1",
            "-vf",
            "scale=1:1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          { encoding: "buffer" },
        );
        return [...stdout];
      };
      const before = await pixel(1);
      const during = await pixel(middle);
      const after = await pixel(visual.end + 0.5);
      assert.ok(
        before[2]! > 220 && before[0]! < 25,
        `Opening source frame is blue: ${before}`,
      );
      assert.ok(
        during[0]! > 220 && during[2]! < 25,
        `Tagged cutaway frame is red: ${during}`,
      );
      assert.ok(
        after[2]! > 220 && after[0]! < 25,
        `Source returns after cutaway: ${after}`,
      );
      const { stdout: samples } = await exec(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-ss",
          String(middle),
          "-i",
          output,
          "-t",
          "0.6",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "8000",
          "-f",
          "s16le",
          "pipe:1",
        ],
        { encoding: "buffer" },
      );
      let positiveCrossings = 0;
      for (let offset = 2; offset < samples.length; offset += 2)
        if (
          samples.readInt16LE(offset - 2) <= 0 &&
          samples.readInt16LE(offset) > 0
        )
          positiveCrossings++;
      const frequency = (positiveCrossings * 8000) / (samples.length / 2);
      assert.ok(
        Math.abs(frequency - 440) < 20,
        `Cutaway retains the 440 Hz source audio, not its own 990 Hz soundtrack: ${frequency.toFixed(1)} Hz`,
      );
      assert.deepEqual(await readdir(path.join(dataDirectory, "work")), []);

      assert.equal(
        (await request(`/api/sources/${source.id}`, "DELETE")).status,
        200,
      );
      assert.deepEqual(
        await assets(),
        [taggedAsset],
        "Removing a source preserves the separate library",
      );
      assert.equal((await fetch(`${base}${asset.url}`)).status, 200);
      assert.equal((await fetch(`${base}${job.downloadUrl}`)).status, 200);
      assert.equal(
        (await request(`/api/batches/${batch.batchId}`, "DELETE")).status,
        200,
      );
      assert.deepEqual(await jobs(), []);
      assert.deepEqual(await readdir(path.join(dataDirectory, "outputs")), []);
      assert.deepEqual(
        await assets(),
        [taggedAsset],
        "Clearing an export batch preserves library assets",
      );
      await stop();
      await start();
      assert.deepEqual(
        await assets(),
        [taggedAsset],
        "Library remains usable after source cleanup and restart",
      );
      assert.equal(
        (await request(`/api/broll/${asset.id}`, "DELETE")).status,
        200,
      );
      assert.deepEqual(await assets(), []);
      assert.equal((await fetch(`${base}${asset.url}`)).status, 404);
      assert.equal((await fetch(`${base}${asset.thumbnailUrl}`)).status, 404);
      assert.equal(
        (await request(`/api/broll/${asset.id}`, "DELETE")).status,
        404,
      );
      assert.deepEqual(await readdir(path.join(dataDirectory, "uploads")), []);
      assert.deepEqual(
        await readdir(path.join(dataDirectory, "thumbnails")),
        [],
      );
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
