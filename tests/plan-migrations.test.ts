import { readWorkspaceFile } from "./helpers/workspace.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type EditPlan } from "../shared/types.js";
import { geometry, probeMedia, renderVideo } from "../server/engine.js";
import { applyEditPlanChanges } from "../server/edit-plan.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);

test("saved Auto plans retain legacy native resolution while new exact exports survive restarts", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-plan-migration-"));
  process.env.DATA_DIR = directory;
  const { initStore, saveStore, state } = await import("../server/store.js");
  const { captureEditPlan, renderInputsFromPlan } = await import("../server/plan-storage.js");
  try {
    await initStore();
    const sourcePath = path.join(directory, "source.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath]);
    const now = new Date().toISOString();
    const source: StoredSource = {
      id: randomUUID(), name: "Low-resolution original.mp4", filePath: sourcePath,
      thumbnailPath: "", thumbnailUrl: "", url: "", size: 1000,
      fingerprint: "fixture-fingerprint", createdAt: now, ...await probeMedia(sourcePath),
    };
    const makeJob = (overrides: Partial<StoredJob> = {}): StoredJob => {
      const id = randomUUID();
      const settings = { ...DEFAULT_SETTINGS, aspect: "16:9" as const, resolution: "1080" as const };
      const editPlan: EditPlan = {
        version: 1, revision: 1, sourceId: source.id, sourceDuration: 1, outputDuration: 1,
        createdAt: now, settings: structuredClone(settings), cuts: [{ start: 0, end: 1 }],
        captions: [{ id: "caption", start: 0.1, end: 0.8, text: "Original caption" }],
        visuals: [], media: [], narration: false,
      };
      return {
        id, sourceId: source.id, sourceName: source.name, batchId: randomUUID(), variant: 1,
        status: "completed", progress: 100, createdAt: now, finishedAt: now,
        outputPath: path.join(directory, "outputs", `${id}.mp4`), settings, editPlan,
        auto: { aspect: "16:9", targetDuration: 30, narration: false },
        summary: { title: "Saved idea", changes: [], sourceDuration: 1, outputDuration: 1,
          transcriptAvailable: true, usedAI: false, narration: false },
        ...overrides,
      };
    };
    const legacy = makeJob();
    await copyFile(sourcePath, legacy.outputPath);
    const alreadyExact = makeJob();
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", sourcePath, "-vf", "scale=1920:1080", "-c:v", "libx264", "-threads", "1",
      "-preset", "ultrafast", "-c:a", "copy", alreadyExact.outputPath]);
    const expired = makeJob(); // Retained plan whose output is no longer available.
    const queuedRevision = makeJob({ status: "queued", parentJobId: legacy.id });
    const manual = makeJob({ status: "queued", auto: undefined, editPlan: undefined });
    const fresh = makeJob({ status: "queued" });
    await captureEditPlan({ job: fresh, source, visuals: [], signal: new AbortController().signal });
    state.sources = [source];
    state.jobs = [legacy, alreadyExact, expired, queuedRevision, manual, fresh];
    await saveStore();
    state.sources = [];
    state.jobs = [];
    await initStore();
    const loaded = (id: string) => state.jobs.find(job => job.id === id)!;

    await t.test("startup migrates old native exports and missing-output plans, preserving exact and manual choices", async () => {
      for (const job of [legacy, expired, queuedRevision]) {
        assert.equal(loaded(job.id).settings.resolution, "source");
        assert.equal(loaded(job.id).editPlan!.settings.resolution, "source");
        assert.equal(loaded(job.id).editPlan!.resolutionSizing, "exact");
      }
      assert.equal(loaded(alreadyExact.id).settings.resolution, "1080", "Actual Full HD pixels override legacy assumptions");
      assert.equal(loaded(fresh.id).editPlan!.resolutionSizing, "exact", "New capture carries an explicit sizing marker");
      assert.equal(loaded(fresh.id).editPlan!.settings.resolution, "1080", "A new exact plan never falls back to a native cap");
      assert.deepEqual(loaded(manual.id), JSON.parse(JSON.stringify(manual)), "Queued manual exports are untouched");
      const persisted = JSON.parse(await readWorkspaceFile(path.join(directory, "state.json"), "utf8")) as { jobs: StoredJob[] };
      assert.equal(persisted.jobs.find(job => job.id === legacy.id)!.editPlan!.settings.resolution, "source");
    });

    await t.test("a caption-only revision renders the same native dimensions and keeps audio", async () => {
      const parent = loaded(legacy.id);
      const edited = applyEditPlanChanges(parent.editPlan!, { revision: 1,
        captions: [{ ...parent.editPlan!.captions[0]!, text: "Corrected caption" }] });
      assert.equal(edited.resolutionSizing, "exact");
      const revision = makeJob({ status: "queued", editPlan: edited, settings: edited.settings });
      const workDir = path.join(directory, "revision-work");
      await mkdir(workDir);
      const inputs = await renderInputsFromPlan(revision, workDir);
      await renderVideo({ input: sourcePath, output: revision.outputPath, source,
        settings: revision.settings, workDir, signal: new AbortController().signal,
        onProgress() {}, ...inputs });
      const original = await probeMedia(parent.outputPath);
      const actual = await probeMedia(revision.outputPath);
      assert.deepEqual([actual.width, actual.height], [original.width, original.height]);
      assert.deepEqual([actual.width, actual.height], [320, 180]);
      assert.equal(actual.hasAudio, true);
      assert.ok(Math.abs(actual.duration - original.duration) < 0.1);
      assert.match(await readFile(inputs.subtitlePath!, "utf8"), /Corrected caption/);
      assert.equal(parent.editPlan!.captions[0]!.text, "Original caption");
    });

    await t.test("migration is idempotent when previously inspected output files expire", async () => {
      const before = structuredClone(state.jobs);
      await rm(alreadyExact.outputPath);
      state.jobs = [];
      await initStore();
      assert.deepEqual(state.jobs, before);
      assert.deepEqual(geometry(source, loaded(alreadyExact.id).editPlan!.settings), { width: 1920, height: 1080 });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
