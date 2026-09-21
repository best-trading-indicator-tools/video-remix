import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DEFAULT_SETTINGS, type EditPlan, type RenderJob } from "../shared/types.js";

test("an approved short retains its outline, renders an editable plan and supports a footage-removal revision", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-draft-api-"));
  const cwd = process.cwd();
  const environment = { DATA_DIR: process.env.DATA_DIR, AUTO_AI: process.env.AUTO_AI };
  let server: Server | undefined, stop: (() => Promise<void>) | undefined;
  try {
    process.chdir(directory);
    process.env.DATA_DIR = path.join(directory, "data"); process.env.AUTO_AI = "false";
    const { initStore, state } = await import("../server/store.js");
    const { createApp } = await import("../server/app.js");
    const { stopQueue } = await import("../server/queue.js"); stop = stopQueue;
    const { runLocal } = await import("../server/auto-process.js");
    await initStore();
    const input = path.join(directory, "input.mp4");
    await runLocal("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "4", "-c:v", "libx264", "-threads", "1", input]);
    server = createApp().listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (url: string, body: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const upload = async (url: string) => {
      const form = new FormData(); form.append("videos", new Blob([await readFile(input)]), "test.mp4");
      const response = await fetch(`${base}${url}`, { method: "POST", body: form });
      assert.equal(response.status, 201, await response.clone().text()); return response.json();
    };
    const source = (await upload("/api/sources")).sources[0];
    const asset = (await upload("/api/broll")).assets[0];
    const draftReview = { summary: "Source demonstration", contribution: "A closer example", approvedAt: new Date().toISOString() };
    const settings = { ...DEFAULT_SETTINGS, aspect: "16:9", resolution: "source", segments: [{ start: 0, end: 3 }], ownFootage: [{
      id: "aacaa565-781a-440c-b0bf-8b76f167e0c8", assetId: asset.id, mode: "cover", at: 1, start: 0, end: 1, audio: "mute", fit: "contain",
    }] };
    const request = await send("/api/jobs", { items: [{ sourceId: source.id, title: "Reviewed idea", settings, draftReview }], variants: 1 });
    assert.equal(request.status, 201, await request.clone().text());
    const id = (await request.json()).jobs[0].id;
    const finished = async (id: string): Promise<RenderJob> => {
      const until = Date.now() + 25000;
      while (Date.now() < until) {
        const job = (await (await fetch(`${base}/api/jobs`)).json()).jobs.find((job: RenderJob) => job.id === id) as RenderJob;
        if (job && !["queued", "processing"].includes(job.status)) { assert.equal(job.status, "completed", job.error); return job; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Test render did not finish");
    };
    const original = await finished(id);
    assert.equal(original.editable, true); assert.deepEqual(original.draftReview, draftReview);
    const plan = await (await fetch(`${base}/api/jobs/${id}/plan`)).json() as EditPlan;
    assert.equal(plan.settings.ownFootage?.length, 1); assert.deepEqual(plan.cuts, settings.segments);
    const originalBytes = await (await fetch(`${base}/api/jobs/${id}/video`)).arrayBuffer();
    const revised = await send(`/api/jobs/${id}/revisions`, { revision: plan.revision, ownFootage: [] });
    assert.equal(revised.status, 201, await revised.clone().text());
    const revision = await finished((await revised.json()).id);
    assert.equal(revision.parentJobId, id); assert.deepEqual(revision.draftReview, draftReview);
    assert.deepEqual(revision.settings.ownFootage, []);
    assert.deepEqual(await (await fetch(`${base}/api/jobs/${id}/video`)).arrayBuffer(), originalBytes);
    const history = state.history.find(entry => entry.jobId === id)!;
    assert.deepEqual(history.draftReview, draftReview);
    const lookup = await send("/api/shorts/review-history", { drafts: [{ id: "draft", sourceId: source.id, cuts: [{ start: 0, end: 2 }] }] });
    assert.equal((await lookup.json()).drafts[0].total, 2, "Both original and correction are visible before another render");
  } finally {
    await stop?.(); server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    process.chdir(cwd);
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
