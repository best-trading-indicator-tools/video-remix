import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, type AutoOptions, type Transcript } from "../shared/types.js";
import { DEFAULT_BLACK_BANDS } from "../shared/black-bands.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);

test("Auto preserves existing captions, supports explicit choices, and keeps speech available to B-roll", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "remix-auto-captions-"));
  const previousCwd = process.cwd();
  const envKeys = ["DATA_DIR", "AUTO_AI", "WHISPER_MODEL", "WHISPER_CACHE_DIR", "DEEPSEEK_API_KEY"] as const;
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    await mkdir(path.join(directory, ".venv", "bin"), { recursive: true });
    await mkdir(path.join(directory, "scripts"));
    const python = path.join(directory, ".venv", "bin", "python");
    await writeFile(python, `#!${process.execPath}\nif (!process.argv.includes('--check')) process.exit(1);\nprocess.stdout.write(JSON.stringify({available:true}));\n`);
    await chmod(python, 0o700);
    await writeFile(path.join(directory, "scripts", "transcribe.py"), "# Availability fixture; speech comes from the validated local cache\n");
    process.chdir(directory);
    Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "false", DEEPSEEK_API_KEY: "",
      WHISPER_MODEL: "caption-fixture", WHISPER_CACHE_DIR: path.join(directory, "models") });
    const { paths } = await import("../server/config.js");
    const { prepareAutoRemix, protectFinalAutoCaptions } = await import("../server/auto.js");
    const { inspectSourceCaptions } = await import("../server/source-captions.js");
    const { captureEditPlan, renderInputsFromPlan, transcriptFromPlan } = await import("../server/plan-storage.js");
    const { applyEditPlanChanges } = await import("../server/edit-plan.js");
    const { autoOptionsSchema } = await import("../server/schema.js");
    const { probeMedia, renderVideo } = await import("../server/engine.js");
    await mkdir(paths.analysis, { recursive: true });
    const sourcePath = path.join(directory, "captioned.mp4");
    const cleanPath = path.join(directory, "clean.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x17202a:s=360x640:r=12:d=8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", cleanPath]);
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", cleanPath,
      "-vf", "drawtext=text='A good morning text.':fontsize=26:fontcolor=white:x=(w-tw)/2:y=h*0.64:enable='lt(t,4)',drawtext=text='It can make your day.':fontsize=26:fontcolor=white:x=(w-tw)/2:y=h*0.64:enable='gte(t,4)'",
      "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "copy", sourcePath]);
    const transcript: Transcript = { language: "en", duration: 8, segments: [
      { start: 0.1, end: 3.8, text: "A good morning text.", words: [] },
      { start: 4.1, end: 7.8, text: "It can make your day.", words: [] },
    ] };
    const sourceFor = async (filePath: string, language = "en"): Promise<StoredSource> => {
      const source = { id: randomUUID(), name: path.basename(filePath), size: (await stat(filePath)).size,
        ...await probeMedia(filePath), createdAt: new Date().toISOString(), url: "", thumbnailUrl: "", filePath,
        thumbnailPath: path.join(directory, "unused.jpg") };
      await writeFile(path.join(paths.analysis, `${source.id}.json`), JSON.stringify({
        key: `v1:caption-fixture:${source.size}:${source.duration}`, transcript: { ...transcript, language },
      }));
      return source;
    };
    const captioned = await sourceFor(sourcePath), clean = await sourceFor(cleanPath);
    const prepare = async (source: StoredSource, captions: AutoOptions["captions"], narration = false, blackBands?: AutoOptions["blackBands"]) => {
      const workDir = path.join(directory, randomUUID()); await mkdir(workDir);
      const job: StoredJob = { id: randomUUID(), batchId: randomUUID(), sourceId: source.id, sourceName: source.name,
        variant: 1, status: "processing", progress: 0, createdAt: new Date().toISOString(),
        outputPath: path.join(directory, `${randomUUID()}.mp4`), settings: { ...DEFAULT_SETTINGS },
        auto: { ...DEFAULT_AUTO_OPTIONS, captions, narration, blackBands, editorialMode: "off",
          captionStyle: { fontSize: 22, bottomPercent: 18, fontFamily: "poppins", color: "#ffe66d", bold: true } } };
      const result = await prepareAutoRemix({ source, job, workDir, signal: new AbortController().signal, onPhase: () => undefined });
      job.settings = result.settings; job.summary = result.summary; job.notes = result.notes;
      await captureEditPlan({ source, job, visuals: [], subtitlePath: result.subtitlePath, audioPath: result.audioPath,
        sourceTranscript: result.sourceTranscript, signal: new AbortController().signal });
      return { job, result, workDir };
    };

    await t.test("user-written band text survives keep-original caption mode and saved Auto plans", async () => {
      const bands = { ...DEFAULT_BLACK_BANDS, enabled: true, topText: "My own heading" };
      const { job, result, workDir } = await prepare(clean, "keep", false, bands);
      assert.deepEqual(result.settings.blackBands, bands);
      assert.deepEqual(job.editPlan?.settings.blackBands, bands);
      assert.equal(result.settings.hookText, "");
      await renderInputsFromPlan(job, workDir);
      assert.deepEqual(job.settings.blackBands, bands);
    });

    await t.test("default Auto detects the original captions and saves a plan with no added text or replacement narration", async () => {
      const { job, result, workDir } = await prepare(captioned, undefined, true);
      assert.equal(result.subtitlePath, undefined);
      assert.equal(result.audioPath, undefined);
      assert.equal(result.summary.narration, false);
      assert.equal(result.settings.hookText, "");
      assert.deepEqual(result.settings.callouts, []);
      assert.ok(result.notes.some(note => /Captions already visible/u.test(note)));
      assert.ok(result.transcript?.segments.length, "B-roll still receives the spoken timeline");
      assert.equal(job.editPlan?.captionMode, "off");
      assert.deepEqual(job.editPlan?.captions, []);
      assert.ok(transcriptFromPlan(job)?.segments.length, "Saved B-roll searches still receive speech without generated captions");
      const inputs = await renderInputsFromPlan(job, workDir);
      assert.equal(inputs.subtitlePath, undefined);
      assert.ok(job.summary?.changes.includes("Existing captions kept"));
      await renderVideo({ input: captioned.filePath, output: job.outputPath, source: captioned,
        settings: job.settings, workDir, ...inputs, signal: new AbortController().signal, onProgress: () => undefined });
      const bottom = path.join(directory, "bottom.jpg");
      await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", "2", "-i", job.outputPath,
        "-vf", "crop=iw:ih*0.2:0:ih*0.8", "-frames:v", "1", bottom]);
      const ocr = await exec("tesseract", [bottom, "stdout", "--psm", "11"]);
      assert.equal(ocr.stdout.trim(), "", "The lower area of the real export has no duplicate generated caption");
      assert.ok((await probeMedia(job.outputPath)).hasAudio);
    });
    await t.test("caption-free footage still receives captions in Auto mode", async () => {
      const { job, result } = await prepare(clean, "auto");
      assert.ok(result.subtitlePath);
      assert.match(await readFile(result.subtitlePath, "utf8"), /morning/u);
      assert.equal(job.editPlan?.captionMode, "generated");
      assert.deepEqual(result.settings.captionStyle, job.auto!.captionStyle);
      assert.deepEqual(job.editPlan?.settings.captionStyle, job.auto!.captionStyle);
    });
    await t.test("Keep original adds no captions even on clean footage, and Add explicitly enables them", async () => {
      const kept = await prepare(clean, "keep");
      assert.equal(kept.result.subtitlePath, undefined);
      assert.equal(kept.job.editPlan?.captionMode, "off");
      kept.job.editPlan = applyEditPlanChanges(kept.job.editPlan!, { revision: 1,
        captions: [{ id: "explicit-caption", start: 0, end: 2, text: "A good morning text." }] }, transcript);
      assert.ok((await renderInputsFromPlan(kept.job, kept.workDir)).subtitlePath);
      assert.equal(kept.job.notes?.some(note => /No new captions were added/u.test(note)), false,
        "A manual addition clears the superseded omission notice");
      const added = await prepare(captioned, "add");
      assert.ok(added.result.subtitlePath);
      assert.ok(added.job.editPlan!.captions.length);
      const removed = applyEditPlanChanges(added.job.editPlan!, { revision: 1, captions: [] }, transcript);
      added.job.editPlan = applyEditPlanChanges(removed, { revision: removed.revision, cuts: [{ start: 1, end: 7 }] }, transcript);
      assert.deepEqual(added.job.editPlan.captions, []);
      assert.equal((await renderInputsFromPlan(added.job, added.workDir)).subtitlePath, undefined,
        "Removing added captions remains effective after a later cut change");
    });
    await t.test("an unavailable OCR language adds no captions and still produces an editable result", async () => {
      const unavailable = await sourceFor(sourcePath, "unsupported-ocr-language");
      const { result, job } = await prepare(unavailable, "auto");
      assert.equal(result.subtitlePath, undefined);
      assert.deepEqual(job.editPlan!.captions, []);
      assert.equal(job.editPlan!.captionMode, "off");
      assert.ok(result.notes.some(note => /detection was unavailable/u.test(note)));
      assert.ok(result.transcript?.segments.length);
    });
    await t.test("final editorial extensions are checked for captions introduced in the newly included footage", async late => {
      const latePath = path.join(directory, "late-captions.mp4");
      await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", cleanPath,
        "-vf", "drawtext=text='A good morning text.':fontsize=26:fontcolor=white:x=(w-tw)/2:y=h*0.64:enable='between(t,3.1,4.5)',drawtext=text='It can make your day.':fontsize=26:fontcolor=white:x=(w-tw)/2:y=h*0.64:enable='gte(t,4.6)'",
        "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "copy", latePath]);
      const source = await sourceFor(latePath);
      const sourceTranscript: Transcript = { language: "en", duration: 8, segments: [
        { start: 0.1, end: 2.8, text: "Start your morning well.", words: [] },
        { start: 3.1, end: 4.5, text: "A good morning text.", words: [] },
        { start: 4.6, end: 7.8, text: "It can make your day.", words: [] },
      ] };
      const previousCuts = [{ start: 0, end: 3 }];
      const before = await inspectSourceCaptions({ source, cuts: previousCuts, transcript: sourceTranscript, signal: new AbortController().signal });
      assert.equal(before.status, "not-detected");
      const { job, workDir } = await prepare(clean, "add");
      job.sourceId = source.id;
      job.editPlan!.sourceId = source.id;
      job.sourceTranscript = sourceTranscript;
      job.editPlan = applyEditPlanChanges(job.editPlan!, { revision: job.editPlan!.revision,
        cuts: [{ start: 0, end: 6 }],
      }, sourceTranscript);
      assert.equal(await protectFinalAutoCaptions({ job, source, signal: new AbortController().signal }), false,
        "Explicit Add mode is retained even when a later cut includes original captions");
      assert.ok(job.editPlan!.captions.length);
      job.auto!.captions = "auto";
      const generated = structuredClone(job);
      assert.equal(await protectFinalAutoCaptions({ job, source, signal: new AbortController().signal }), true);
      assert.deepEqual(job.editPlan!.captions, []);
      assert.equal(job.editPlan!.captionMode, "off");
      assert.equal(job.editPlan!.settings.hookText, "");
      assert.deepEqual(job.editPlan!.settings.callouts, []);
      assert.equal((await renderInputsFromPlan(job, workDir)).subtitlePath, undefined);

      await late.test("an interrupted final check remains protective after serialization and retry with identical cuts", async () => {
        const interrupted = structuredClone(generated);
        const cuts = structuredClone(interrupted.editPlan!.cuts);
        const controller = new AbortController();
        const pending = protectFinalAutoCaptions({ job: interrupted, source, signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: "AbortError" });
        assert.ok(interrupted.editPlan!.captions.length, "The interrupted inspection has not applied its decision");
        interrupted.status = "cancelled";
        const restored: StoredJob = JSON.parse(JSON.stringify(interrupted));
        restored.status = "queued";
        assert.deepEqual(restored.editPlan!.cuts, cuts, "A retry retains the already-repaired timestamps");
        assert.equal(await protectFinalAutoCaptions({ job: restored, source, signal: new AbortController().signal }), true);
        assert.deepEqual(restored.editPlan!.cuts, cuts);
        assert.deepEqual(restored.editPlan!.captions, []);
        assert.equal(restored.editPlan!.captionMode, "off");
        assert.equal(restored.editPlan!.settings.hookText, "");
        assert.equal((await renderInputsFromPlan(restored, workDir)).subtitlePath, undefined);
      });

      await late.test("a saved manual recut remains protected when editorial checks are off", async () => {
        const revised = structuredClone(generated);
        const parent = applyEditPlanChanges(revised.editPlan!, { revision: revised.editPlan!.revision,
          cuts: previousCuts,
        }, sourceTranscript);
        assert.ok(parent.captions.length, "The clean parent interval has generated captions");
        revised.parentJobId = randomUUID();
        revised.auto!.editorialMode = "off";
        revised.editPlan = applyEditPlanChanges(parent, { revision: parent.revision,
          cuts: generated.editPlan!.cuts,
        }, sourceTranscript);
        assert.ok(revised.editPlan.captions.length, "A plain cut change generates captions for newly selected speech");
        assert.equal(revised.auto!.captions, "auto", "Changing cuts alone does not request a caption override");
        assert.equal(await protectFinalAutoCaptions({ job: revised, source, signal: new AbortController().signal }), true);
        assert.deepEqual(revised.editPlan.captions, []);
        assert.equal(revised.editPlan.captionMode, "off");
        assert.deepEqual(revised.editPlan.settings.callouts, []);
        assert.equal((await renderInputsFromPlan(revised, workDir)).subtitlePath, undefined);
      });
    });
    await t.test("caption preferences reject unsupported modes at the API boundary", () => {
      for (const captions of ["auto", "add", "keep"]) assert.equal(autoOptionsSchema.parse({ captions }).captions, captions);
      assert.equal(autoOptionsSchema.safeParse({ captions: "erase" }).success, false);
    });
  } finally {
    process.chdir(previousCwd);
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
