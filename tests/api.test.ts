import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import {
  DEFAULT_SETTINGS,
  type RenderJob,
  type VideoSource,
} from "../shared/types.js";
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
test(
  "batch API uploads, validates, renders, cancels, retries, downloads ZIP, and restores workspace",
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "remix-api-"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let processLog = "";
    let server: ChildProcess | undefined;
    const start = async () => {
      server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          // This suite exercises storage and rendering, not installed speech/cloud models.
          AUTO_AI: "false", DEEPSEEK_API_KEY: "",
          PORT: String(port),
          HOST: "127.0.0.1",
          DATA_DIR: path.join(directory, "data"),
          RENDER_CONCURRENCY: "1",
          MAX_FILES: "3",
          MAX_FILE_SIZE_MB: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout?.on("data", (chunk) => {
        processLog += chunk.toString();
      });
      server.stderr?.on("data", (chunk) => {
        processLog += chunk.toString();
      });
      for (let tries = 0; tries < 100; tries++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) return;
        } catch {
          /* Starting */
        }
        if (server.exitCode !== null) throw new Error(processLog);
        await sleep(100);
      }
      throw new Error(`App did not start: ${processLog}`);
    };
    const stop = async () => {
      if (!server || server.exitCode !== null) return;
      const processToStop = server;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => processToStop.kill("SIGKILL"), 7000);
        processToStop.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        processToStop.kill("SIGTERM");
      });
    };
    const json = async (url: string, body: unknown) =>
      fetch(`${base}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const upload = async (files: { name: string; data: Uint8Array }[]) => {
      const form = new FormData();
      files.forEach((file) =>
        form.append("videos", new Blob([file.data]), file.name),
      );
      return fetch(`${base}/api/sources`, { method: "POST", body: form });
    };
    const waitFor = async (predicate: (jobs: RenderJob[]) => boolean) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const { jobs } = (await (await fetch(`${base}/api/jobs`)).json()) as {
          jobs: RenderJob[];
        };
        if (predicate(jobs)) return jobs;
        await sleep(100);
      }
      throw new Error(`Render timed out: ${processLog}`);
    };
    try {
      const fixture = path.join(directory, "fixture.mp4");
      await exec("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=240x320:rate=15",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        fixture,
      ]);
      await start();
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.maxFiles, 3);
      assert.equal(
        (
          await fetch(`${base}/api/sources`, {
            headers: { Origin: "https://unrelated.example" },
          })
        ).status,
        403,
      );
      const hostileHostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          http
            .get(
              `${base}/api/sources`,
              { headers: { Host: "unrelated.example" } },
              (response) => {
                response.resume();
                resolve(response.statusCode);
              },
            )
            .on("error", reject);
        },
      );
      assert.equal(hostileHostStatus, 403);
      const data = await readFile(fixture);
      const response = await upload([
        { name: "First video.mp4", data },
        { name: "été vidéo.mov", data },
      ]);
      assert.equal(response.status, 201, await response.clone().text());
      const { sources } = (await response.json()) as { sources: VideoSource[] };
      assert.equal(sources.length, 2);
      assert.equal(sources[1]!.name, "été vidéo.mov");
      assert.equal(sources[0]!.width, 240);
      assert.equal(sources[0]!.hasAudio, true);
      assert.equal("filePath" in sources[0]!, false);
      const ranged = await fetch(`${base}${sources[0]!.url}`, {
        headers: { Range: "bytes=0-63" },
      });
      assert.equal(ranged.status, 206);
      assert.equal((await ranged.arrayBuffer()).byteLength, 64);
      assert.equal(
        (await fetch(`${base}${sources[0]!.thumbnailUrl}`)).headers.get(
          "content-type",
        ),
        "image/jpeg",
      );
      const partial = await upload([
        { name: "good.mp4", data },
        { name: "broken.mp4", data: new TextEncoder().encode("not a video") },
      ]);
      assert.equal(partial.status, 201);
      const partialBody = await partial.json();
      assert.equal(partialBody.sources.length, 1);
      assert.equal(partialBody.errors.length, 1);
      const deleteResults = await Promise.all(
        [1, 2].map(() =>
          fetch(`${base}/api/sources/${partialBody.sources[0].id}`, {
            method: "DELETE",
          }),
        ),
      );
      assert.deepEqual(
        deleteResults.map((result) => result.status).sort(),
        [200, 404],
      );
      assert.equal(
        (await (await fetch(`${base}/api/sources`)).json()).sources.length,
        2,
      );
      assert.equal((await upload([{ name: "bad.exe", data }])).status, 400);
      assert.equal(
        (
          await upload([
            { name: "oversize.mp4", data: new Uint8Array(2 * 1024 * 1024 + 1) },
          ])
        ).status,
        400,
      );
      assert.equal(
        (
          await json("/api/jobs", {
            items: [
              {
                sourceId: sources[0]!.id,
                settings: { ...DEFAULT_SETTINGS, speed: 0 },
              },
            ],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await json("/api/jobs", {
            items: [
              {
                sourceId: sources[0]!.id,
                settings: { ...DEFAULT_SETTINGS, trimStart: 2, trimEnd: 1 },
              },
            ],
          })
        ).status,
        400,
      );
      const srt = new FormData();
      srt.append("kind", "subtitle");
      srt.append(
        "file",
        new Blob(["1\n00:00:00,100 --> 00:00:01,200\nA new story\n"]),
        "captions.srt",
      );
      const srtResponse = await fetch(`${base}/api/attachments`, {
        method: "POST",
        body: srt,
      });
      assert.equal(srtResponse.status, 201);
      const subtitle = await srtResponse.json();
      const invalidSrt = new FormData();
      invalidSrt.append("kind", "subtitle");
      invalidSrt.append("file", new Blob(["invalid"]), "invalid.srt");
      assert.equal(
        (
          await fetch(`${base}/api/attachments`, {
            method: "POST",
            body: invalidSrt,
          })
        ).status,
        400,
      );
      const batchResponse = await json("/api/jobs", {
        items: sources.map((source, index) => ({
          sourceId: source.id,
          settings: {
            ...DEFAULT_SETTINGS,
            aspect: "1:1",
            trimEnd: 2,
            hookText: index === 0 ? "It's a 100% new cut: [test]" : "",
            subtitleId: index === 0 ? subtitle.id : null,
          },
        })),
        variants: 2,
        randomize: false,
      });
      assert.equal(
        batchResponse.status,
        201,
        await batchResponse.clone().text(),
      );
      const batch = (await batchResponse.json()) as {
        jobs: RenderJob[];
        batchId: string;
      };
      assert.equal(batch.jobs.length, 4);
      const queued = batch.jobs[3]!;
      assert.equal(
        (
          await fetch(`${base}/api/sources/${queued.sourceId}`, {
            method: "DELETE",
          })
        ).status,
        409,
      );
      assert.equal(
        (await json(`/api/jobs/${queued.id}/cancel`, {})).status,
        200,
      );
      let jobs = await waitFor((jobs) =>
        jobs
          .filter((job) => job.batchId === batch.batchId)
          .every((job) => !["queued", "processing"].includes(job.status)),
      );
      assert.equal(
        jobs.find((job) => job.id === queued.id)?.status,
        "cancelled",
      );
      assert.equal(
        jobs.filter((job) => job.status === "completed").length,
        3,
        JSON.stringify(jobs),
      );
      assert.equal(
        (await json(`/api/jobs/${queued.id}/retry`, {})).status,
        200,
      );
      jobs = await waitFor((jobs) =>
        jobs.every((job) => job.status === "completed"),
      );
      assert.equal(jobs.length, 4);
      assert.equal(
        jobs.every((job) => job.progress === 100),
        true,
      );
      const renderedPreview = await fetch(
        `${base}/api/jobs/${jobs[0]!.id}/video`,
        { headers: { Range: "bytes=0-63" } },
      );
      assert.equal(renderedPreview.status, 206);
      assert.equal((await renderedPreview.arrayBuffer()).byteLength, 64);
      const output = await fetch(`${base}${jobs[0]!.downloadUrl}`);
      assert.equal(output.status, 200);
      assert.match(output.headers.get("content-disposition")!, /attachment/);
      const outputPath = path.join(directory, "result.mp4");
      await writeFile(outputPath, Buffer.from(await output.arrayBuffer()));
      const { stdout: probe } = await exec("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        outputPath,
      ]);
      const video = JSON.parse(probe).streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      );
      assert.equal(video.width, 240);
      assert.equal(video.height, 240);
      const zip = await fetch(`${base}/api/batches/${batch.batchId}/download`);
      assert.equal(zip.status, 200);
      const zipPath = path.join(directory, "batch.zip");
      await writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
      const { stdout: zipListing } = await exec("unzip", ["-t", zipPath]);
      assert.match(zipListing, /No errors detected/);
      assert.match(zipListing, /export-settings.json/);
      await stop();
      await start();
      const restored = await (await fetch(`${base}/api/jobs`)).json();
      assert.equal(restored.jobs.length, 4);
      assert.equal(
        restored.jobs.every((job: RenderJob) => job.status === "completed"),
        true,
      );
      assert.equal(
        (
          await fetch(`${base}/api/sources/${sources[0]!.id}`, {
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/api/sources/${sources[0]!.id}/video`)).status,
        404,
      );
      assert.equal(
        (
          await fetch(
            `${base}${jobs.find((job) => job.sourceId === sources[0]!.id)!.downloadUrl}`,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${base}/api/batches/${batch.batchId}`, {
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.equal(
        (await (await fetch(`${base}/api/jobs`)).json()).jobs.length,
        0,
      );
      assert.equal((await fetch(`${base}${jobs[0]!.downloadUrl}`)).status, 404);
    } finally {
      await stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
