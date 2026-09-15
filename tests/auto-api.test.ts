import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { RenderJob, VideoSource } from "../shared/types.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

// Read ZIP central-directory filenames without depending on a system unzip.
function zipNames(buffer: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 46 <= buffer.length; offset++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(
      buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
    );
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}

test(
  "automatic batch API validates, edits silent/tone footage, retries cancelled jobs, and cleans its artifacts",
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "remix-auto-api-"));
    const dataDirectory = path.join(directory, "workspace");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let server: ChildProcess | undefined;
    let processLog = "";
    const post = (url: string, body: unknown) =>
      fetch(`${base}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const jobs = async () =>
      (
        (await (await fetch(`${base}/api/jobs`)).json()) as {
          jobs: RenderJob[];
        }
      ).jobs;
    const waitFor = async (predicate: (items: RenderJob[]) => boolean) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const current = await jobs();
        if (predicate(current)) return current;
        if (current.some((job) => job.status === "failed"))
          throw new Error(
            `Automatic edit failed: ${JSON.stringify(current)}\n${processLog}`,
          );
        await sleep(100);
      }
      throw new Error(`Automatic jobs timed out: ${processLog}`);
    };
    const stop = async () => {
      if (!server || server.exitCode !== null) return;
      const child = server;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    };
    try {
      const silent = path.join(directory, "silent.mp4");
      const tone = path.join(directory, "tone.mp4");
      await exec("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=15:duration=3",
        "-an",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        silent,
      ]);
      await exec("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        "-i",
        silent,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=3",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        tone,
      ]);
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
      server.stdout?.on("data", (chunk) => {
        processLog = (processLog + chunk.toString()).slice(-12000);
      });
      server.stderr?.on("data", (chunk) => {
        processLog = (processLog + chunk.toString()).slice(-12000);
      });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) {
            ready = true;
            break;
          }
        } catch {
          /* Start-up. */
        }
        if (server.exitCode !== null) throw new Error(processLog);
        await sleep(100);
      }
      assert.ok(ready, processLog);
      const capabilities = await (
        await fetch(`${base}/api/auto/capabilities`)
      ).json();
      assert.equal(capabilities.transcription, false);
      assert.equal(capabilities.intelligence, false);
      assert.equal(capabilities.narration, false);
      assert.match(capabilities.message, /setup:auto/);

      const form = new FormData();
      form.append(
        "videos",
        new Blob([await readFile(silent)]),
        "Silent landscape.mp4",
      );
      form.append(
        "videos",
        new Blob([await readFile(tone)]),
        "Tone without speech.mp4",
      );
      const uploaded = await fetch(`${base}/api/sources`, {
        method: "POST",
        body: form,
      });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const { sources } = (await uploaded.json()) as { sources: VideoSource[] };
      assert.deepEqual(
        sources.map((source) => source.hasAudio),
        [false, true],
      );
      const sourceIds = sources.map((source) => source.id);
      assert.equal(
        (
          await post("/api/auto/jobs", {
            sourceIds: [sourceIds[0], randomUUID()],
          })
        ).status,
        404,
      );
      assert.equal(
        (await post("/api/auto/jobs", { sourceIds: ["not-a-uuid"] })).status,
        400,
      );
      assert.equal(
        (
          await post("/api/auto/jobs", {
            sourceIds,
            options: { aspect: "2:3", targetDuration: 15 },
          })
        ).status,
        400,
      );
      assert.equal(
        (await post("/api/auto/jobs", { sourceIds, variants: 6 })).status,
        400,
      );
      assert.equal(
        (await jobs()).length,
        0,
        "Rejected automatic batches do not partially enqueue work",
      );

      const response = await post("/api/auto/jobs", {
        sourceIds: [...sourceIds, sourceIds[0]],
        variants: 2,
        options: { aspect: "9:16", targetDuration: 30, narration: true },
      });
      assert.equal(response.status, 201, await response.clone().text());
      const batch = (await response.json()) as {
        batchId: string;
        jobs: RenderJob[];
      };
      assert.equal(
        batch.jobs.length,
        4,
        "Repeated source IDs are deduplicated",
      );
      assert.ok(batch.jobs.every((job) => job.auto?.aspect === "9:16"));
      const cancelled = batch.jobs.at(-1)!;
      assert.equal(cancelled.status, "queued");
      assert.equal(
        (await post(`/api/jobs/${cancelled.id}/cancel`, {})).status,
        200,
      );
      let finished = await waitFor((items) =>
        items.every((job) => !["queued", "processing"].includes(job.status)),
      );
      assert.equal(
        finished.find((job) => job.id === cancelled.id)?.status,
        "cancelled",
      );
      assert.equal(
        finished.filter((job) => job.status === "completed").length,
        2,
      );
      assert.equal(
        (await post(`/api/jobs/${cancelled.id}/retry`, {})).status,
        200,
      );
      finished = await waitFor(
        (items) =>
          items.length === 4 &&
          items.every((job) => ["completed", "skipped"].includes(job.status)),
      );
      const skipped = finished.filter((job) => job.status === "skipped");
      assert.equal(
        skipped.length,
        2,
        "Extra versions of a short clip are skipped instead of exported twice",
      );
      for (const job of skipped) {
        assert.equal(job.downloadUrl, undefined);
        assert.ok(job.notes?.length);
        assert.equal((await post(`/api/jobs/${job.id}/retry`, {})).status, 409);
      }
      const completed = finished.filter((job) => job.status === "completed");
      for (const job of completed) {
        assert.equal(job.progress, 100);
        assert.equal(job.summary?.usedAI, false);
        assert.equal(job.summary?.narration, false);
        assert.equal(job.summary?.transcriptAvailable, false);
        assert.ok(Math.abs(job.summary!.outputDuration - 3) < 0.06);
        assert.ok(
          job.notes?.some((note) => /no usable spoken excerpt/i.test(note)),
        );
        assert.equal(job.captionUrl, undefined);
        assert.equal(
          (await fetch(`${base}/api/jobs/${job.id}/captions`)).status,
          404,
        );
      }
      assert.ok(
        completed
          .find((job) => job.sourceId === sources[1]!.id)!
          .notes?.some((note) => /not installed/i.test(note)),
      );
      const silentJob = completed.find(
        (job) => job.sourceId === sources[0]!.id,
      )!;
      const toneJob = completed.find((job) => job.sourceId === sources[1]!.id)!;
      for (const [job, hasAudio] of [
        [silentJob, false],
        [toneJob, true],
      ] as const) {
        const downloaded = await fetch(`${base}${job.downloadUrl}`);
        assert.equal(downloaded.status, 200);
        const output = path.join(directory, `${job.id}.mp4`);
        await writeFile(output, Buffer.from(await downloaded.arrayBuffer()));
        const { stdout } = await exec("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          output,
        ]);
        const parsed = JSON.parse(stdout);
        const video = parsed.streams.find(
          (stream: { codec_type: string }) => stream.codec_type === "video",
        );
        assert.deepEqual(
          [video.width, video.height, video.avg_frame_rate],
          [320, 568, "30/1"],
        );
        assert.ok(Math.abs(Number(parsed.format.duration) - 3) < 0.08);
        assert.equal(
          parsed.streams.some(
            (stream: { codec_type: string }) => stream.codec_type === "audio",
          ),
          hasAudio,
        );
      }
      const zipped = await fetch(
        `${base}/api/batches/${batch.batchId}/download`,
      );
      assert.equal(zipped.status, 200);
      const archive = Buffer.from(await zipped.arrayBuffer());
      assert.equal(archive.readUInt32LE(0), 0x04034b50);
      const entries = zipNames(archive);
      assert.equal(entries.filter((name) => name.endsWith(".mp4")).length, 2);
      assert.ok(entries.includes("export-settings.json"));
      assert.equal(
        entries.some((name) => name.endsWith(".srt")),
        false,
      );
      assert.deepEqual(
        await readdir(path.join(dataDirectory, "work")),
        [],
        "Auto preparation and rendering temporary files are removed",
      );

      const cache = path.join(
        dataDirectory,
        "analysis",
        `${sources[0]!.id}.json`,
      );
      await writeFile(cache, JSON.stringify({ syntheticTestMarker: true }));
      assert.equal(
        (
          await fetch(`${base}/api/sources/${sources[0]!.id}`, {
            method: "DELETE",
          })
        ).status,
        200,
      );
      await assert.rejects(stat(cache), { code: "ENOENT" });
      assert.equal((await fetch(`${base}${sources[0]!.url}`)).status, 404);
      assert.equal(
        (await fetch(`${base}${silentJob.downloadUrl}`)).status,
        200,
        "Finished automatic edits survive removal of their source",
      );
      assert.equal(
        (
          await fetch(`${base}/api/batches/${batch.batchId}`, {
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.equal((await jobs()).length, 0);
      assert.deepEqual(await readdir(path.join(dataDirectory, "outputs")), []);
      assert.equal(
        (await fetch(`${base}${silentJob.downloadUrl}`)).status,
        404,
      );
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
