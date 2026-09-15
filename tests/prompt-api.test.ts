import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { test } from "node:test";
import type { EditPlan, PromptEditResponse, RenderJob } from "../shared/types.js";
import { DEFAULT_SETTINGS } from "../shared/types.js";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function freePort() {
  const listener = net.createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

test("prompt suggestions preserve saved exports and compose with unsaved edits before rendering", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-prompt-api-"));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const replyPath = path.join(directory, "reply.json"), callsPath = path.join(directory, "calls.jsonl");
  let server: ChildProcess | undefined;
  let log = "";
  const request = (route: string, body: unknown, signal?: AbortSignal) => fetch(`${base}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  const jobs = async () => (await (await fetch(`${base}/api/jobs`)).json()).jobs as RenderJob[];
  const planOf = async (id: string) => (await (await fetch(`${base}/api/jobs/${id}/plan`)).json()) as EditPlan;
  const reply = (operations: unknown[], clarification?: string) => writeFile(replyPath, JSON.stringify({ operations, ...(clarification ? { clarification } : {}) }));
  const calls = async () => (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const completed = async (id: string) => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const job = (await jobs()).find(item => item.id === id);
      if (job?.status === "completed") return job;
      if (job && !["queued", "processing"].includes(job.status)) throw new Error(JSON.stringify(job));
      await sleep(100);
    }
    throw new Error(`Render timed out: ${log}`);
  };
  try {
    await writeFile(callsPath, "");
    const preload = path.join(directory, "mock-provider.mjs");
    await writeFile(preload, `
import { readFile, appendFile } from 'node:fs/promises';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://api.deepseek.com/chat/completions') return original(input, init);
  const body = JSON.parse(String(init.body));
  await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ messages: body.messages, temperature: body.temperature }) + '\\n');
  const value = JSON.parse(await readFile(${JSON.stringify(replyPath)}, 'utf8'));
  if (value.wait) await new Promise((resolve,reject) => { const timer=setTimeout(resolve, 10000); init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, {once:true}); });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value.wait ? {operations:[]} : value) } }] });
};`);
    server = spawn(process.execPath, ["--import", preload, "--import", "tsx", "server/index.ts"], {
      cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: path.join(directory, "data"),
        AUTO_AI: "false", WHISPER_CACHE_DIR: path.join(directory, "no-model"),
        DEEPSEEK_API_KEY: "test-private-prompt-key", PIXABAY_API_KEY: "", RENDER_CONCURRENCY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { log = (log + chunk.toString()).slice(-12000); });
    const deadline = Date.now() + 12000;
    while (true) {
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { /* starting */ }
      if (Date.now() >= deadline || server.exitCode !== null) throw new Error(`Server did not start: ${log}`);
      await sleep(100);
    }
    const sourcePath = path.join(directory, "source.mp4");
    await exec("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=500:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath]);
    const form = new FormData(); form.append("videos", new Blob([await readFile(sourcePath)]), "example.mp4");
    const upload = await fetch(`${base}/api/sources`, { method: "POST", body: form });
    assert.equal(upload.status, 201);
    const source = (await upload.json()).sources[0];
    const initial = await request("/api/auto/jobs", { sourceIds: [source.id], variants: 1,
      options: { aspect: "16:9", targetDuration: 30, narration: false, supportingVisuals: "off" } });
    assert.equal(initial.status, 201);
    const first = await completed((await initial.json()).jobs[0].id);
    const firstPlan = await planOf(first.id);
    const withCaption = await request(`/api/jobs/${first.id}/revisions`, { revision: firstPlan.revision,
      hookText: "An original headline", captions: [{ id: "caption-1", start: 1, end: 3, text: "A spoken example" }] });
    assert.equal(withCaption.status, 201);
    const parent = await completed((await withCaption.json()).id), plan = await planOf(parent.id);
    const parentBytes = new Uint8Array(await (await fetch(`${base}${parent.downloadUrl}`)).arrayBuffer());
    const route = `/api/jobs/${parent.id}/edit-prompt`;
    const beforeJobs = (await jobs()).length;
    let proposal!: PromptEditResponse;
    await t.test("a suggestion composes with unsaved captions but creates no job and exposes no secrets or paths", async () => {
      await reply([{ op: "hook", text: "A clearer headline" }, { op: "caption_style", fontSize: 16, bottomPercent: 18 }]);
      const response = await request(route, { revision: plan.revision, prompt: "Change the hook and make captions smaller and higher",
        draft: { revision: plan.revision, captions: [{ ...plan.captions[0]!, text: "My manual correction" }] } });
      assert.equal(response.status, 200, await response.clone().text());
      proposal = await response.json();
      assert.equal(proposal.plan.settings.hookText, "A clearer headline");
      assert.equal(proposal.plan.settings.captionStyle?.fontSize, 16);
      assert.equal(proposal.plan.captions[0]!.text, "My manual correction");
      assert.equal(proposal.changes.captions?.[0]?.text, "My manual correction");
      assert.equal(proposal.changes.revision, plan.revision);
      assert.deepEqual(proposal.plan.cuts, plan.cuts);
      assert.deepEqual(await planOf(parent.id), plan);
      assert.equal((await jobs()).length, beforeJobs);
      assert.ok(proposal.summary.length >= 2);
      const sent = JSON.stringify((await calls()).at(-1));
      const received = JSON.stringify(proposal);
      for (const text of [sent, received]) {
        assert.ok(!text.includes(directory)); assert.ok(!text.includes("test-private-prompt-key"));
      }
    });
    await t.test("clarification never applies partial operations or discards an unsaved draft", async () => {
      await reply([{ op: "hook", text: "Must not apply" }], "Which sentence should be shorter?");
      const response = await request(route, { revision: plan.revision, prompt: "Make that shorter",
        draft: { revision: plan.revision, hookText: "My unsaved heading" } });
      assert.equal(response.status, 200);
      const value = await response.json() as PromptEditResponse;
      assert.match(value.clarification!, /Which sentence/);
      assert.deepEqual(value.changes, { revision: plan.revision });
      assert.equal(value.plan.settings.hookText, "My unsaved heading");
      assert.equal((await jobs()).length, beforeJobs);
    });
    await t.test("invalid or stale drafts are rejected before using the model", async () => {
      const count = (await calls()).length;
      for (const body of [
        { revision: plan.revision + 1, prompt: "Remove captions" },
        { revision: plan.revision, prompt: "" },
        { revision: plan.revision, prompt: "x".repeat(2001) },
        { revision: plan.revision, prompt: "Edit", draft: { revision: plan.revision - 1 } },
        { revision: plan.revision, prompt: "Edit", draft: { revision: plan.revision, cuts: [{ start: 0, end: 999 }] } },
      ]) assert.ok([400, 409].includes((await request(route, body)).status));
      assert.equal((await request(`/api/jobs/${randomUUID()}/edit-prompt`, { revision: 1, prompt: "Edit" })).status, 404);
      assert.equal((await calls()).length, count);
    });
    await t.test("output trims retain automatic caption retiming in the cumulative patch", async () => {
      await reply([{ op: "trim", start: 1, end: 5 }]);
      const response = await request(route, { revision: plan.revision, prompt: "Keep seconds 1 to 5" });
      assert.equal(response.status, 200, await response.clone().text());
      const value = await response.json() as PromptEditResponse;
      assert.equal(value.plan.outputDuration, 4);
      assert.equal(value.plan.captions[0]!.start, 0);
      assert.equal(value.changes.captions, undefined, "Automatic retiming must stay implicit");
      assert.equal(value.changes.visuals, undefined);
    });
    await t.test("cancelled proposals free their slot and simultaneous suggestions are bounded", async () => {
      await writeFile(replyPath, JSON.stringify({ wait: true }));
      const count = (await calls()).length;
      const controller = new AbortController();
      const running = request(route, { revision: plan.revision, prompt: "Change hook" }, controller.signal).catch(() => undefined);
      while ((await calls()).length === count) await sleep(10);
      assert.equal((await request(route, { revision: plan.revision, prompt: "Change hook again" })).status, 429);
      controller.abort(); await running;
      await reply([{ op: "hook", text: "After cancellation" }]);
      let response: Response;
      const deadline = Date.now() + 2000;
      do { await sleep(20); response = await request(route, { revision: plan.revision, prompt: "Change hook again" }); } while (response.status === 429 && Date.now() < deadline);
      assert.equal(response.status, 200, await response.clone().text());
    });
    await t.test("only the reviewed revision request renders, preserving the original bytes and media choices", async () => {
      const response = await request(`/api/jobs/${parent.id}/revisions`, proposal.changes);
      assert.equal(response.status, 201, await response.clone().text());
      const child = await completed((await response.json()).id), next = await planOf(child.id);
      assert.equal((await jobs()).length, beforeJobs + 1);
      assert.equal(next.settings.hookText, "A clearer headline");
      assert.equal(next.captions[0]!.text, "My manual correction");
      assert.deepEqual(next.cuts, plan.cuts);
      assert.deepEqual(next.media, plan.media);
      assert.deepEqual(await planOf(parent.id), plan);
      assert.equal(digest(new Uint8Array(await (await fetch(`${base}${parent.downloadUrl}`)).arrayBuffer())), digest(parentBytes));
      assert.ok(child.outputSize! > 1000);
    });
    await t.test("manual prompts propose exact settings and render only through the existing export action", async () => {
      const count = (await jobs()).length;
      const settings = { ...DEFAULT_SETTINGS, contrast: 1.17, saturation: 0.9 };
      await writeFile(replyPath, JSON.stringify({ patch: { speed: 1.25, temperature: 0.2, muted: true,
        aspect: "9:16", resolution: "1080", trimStart: 1, trimEnd: 6 } }));
      const response = await request(`/api/sources/${source.id}/edit-prompt`, { settings,
        prompt: "Use source seconds 1 to 6, 1.25x speed, warmer, mute audio, and portrait 1080p." });
      assert.equal(response.status, 200, await response.clone().text());
      const proposal = await response.json();
      assert.equal(proposal.settings.contrast, 1.17);
      assert.equal(proposal.settings.saturation, 0.9);
      assert.equal(proposal.settings.trimStart, 1);
      assert.equal(proposal.settings.trimEnd, 6);
      assert.equal(proposal.settings.resolution, "1080");
      assert.equal(proposal.settings.muted, true);
      assert.ok(proposal.summary.length >= 5);
      assert.equal((await jobs()).length, count);
      const render = await request("/api/jobs", { items: [{ sourceId: source.id, settings: proposal.settings, title: "Prompt fixture" }], variants: 1, randomize: false });
      assert.equal(render.status, 201, await render.clone().text());
      const job = await completed((await render.json()).jobs[0].id);
      const output = path.join(directory, "manual-prompt.mp4");
      await writeFile(output, new Uint8Array(await (await fetch(`${base}${job.downloadUrl}`)).arrayBuffer()));
      const metadata = JSON.parse((await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", output])).stdout);
      assert.ok(metadata.streams.some((stream: { width: number; height: number }) => stream.width === 1080 && stream.height === 1920));
      assert.ok(!metadata.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"));
      assert.ok(Math.abs(Number(metadata.format.duration) - 4) < 0.1);
    });
    await t.test("manual clarification and invalid settings do not queue exports or lose existing choices", async () => {
      const count = (await jobs()).length;
      await writeFile(replyPath, JSON.stringify({ patch: { muted: true }, clarification: "Which color style do you want?" }));
      const route = `/api/sources/${source.id}/edit-prompt`;
      const response = await request(route, { settings: DEFAULT_SETTINGS, prompt: "Make it look better" });
      assert.equal(response.status, 200);
      const proposal = await response.json();
      assert.ok(proposal.clarification);
      assert.deepEqual(proposal.settings, DEFAULT_SETTINGS);
      const callCount = (await calls()).length;
      for (const settings of [{ ...DEFAULT_SETTINGS, speed: 9 }, { ...DEFAULT_SETTINGS, filePath: "/etc/passwd" }, { ...DEFAULT_SETTINGS, trimEnd: 900 }])
        assert.equal((await request(route, { settings, prompt: "Make it brighter" })).status, 400);
      assert.equal((await request(`/api/sources/${randomUUID()}/edit-prompt`, { settings: DEFAULT_SETTINGS, prompt: "Brighter" })).status, 404);
      assert.equal((await calls()).length, callCount);
      assert.equal((await jobs()).length, count);
    });
  } finally {
    if (server && server.exitCode === null) {
      const child = server;
      await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill("SIGKILL"), 5000); timer.unref(); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
