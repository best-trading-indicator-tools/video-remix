import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, MAX_AUTO_VERSIONS, type Transcript } from "../shared/types.js";
import type { EditorialPlan } from "../server/diversity.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);
const speech = (start: number, end: number, text: string) => ({ start, end, text, words: [] });
const reused = /reuses footage from an earlier export/iu;

test("Auto treats previous batches as a preference while preserving same-batch repeat protection", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "auto-history-planning-"));
  const previousCwd = process.cwd();
  const environmentKeys = ["DATA_DIR", "AUTO_AI", "AUTO_LOCAL_AI", "DEEPSEEK_API_KEY", "DEEPSEEK_TEXT_MODEL", "PIXABAY_API_KEY", "WHISPER_MODEL", "WHISPER_CACHE_DIR"] as const;
  const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  let restoreFetch: (() => void) | undefined;
  try {
    // Only the availability probe is stubbed. Every tested speech path must read
    // its validated cached transcript; attempting transcription fails the fixture.
    await mkdir(path.join(directory, ".venv", "bin"), { recursive: true });
    await mkdir(path.join(directory, "scripts"), { recursive: true });
    const python = path.join(directory, ".venv", "bin", "python");
    await writeFile(python, `#!${process.execPath}\nif (!process.argv.includes('--check')) { process.stderr.write('Unexpected transcription in cached planning test'); process.exit(1); }\nprocess.stdout.write(JSON.stringify({available:true}));\n`);
    await chmod(python, 0o700);
    await writeFile(path.join(directory, "scripts", "transcribe.py"), "# Availability-only fixture\n");
    process.chdir(directory);
    Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "false", AUTO_LOCAL_AI: "false",
      DEEPSEEK_API_KEY: "history-planning-test-key", DEEPSEEK_TEXT_MODEL: "history-planning-test-model", PEXELS_API_KEY: "", PIXABAY_API_KEY: "",
      WHISPER_MODEL: "history-planning-test", WHISPER_CACHE_DIR: path.join(directory, "models") });
    const { config, paths } = await import("../server/config.js");
    const { AutoSkipError, prepareAutoRemix } = await import("../server/auto.js");
    const { cutsDuration } = await import("../server/auto-plan.js");
    const { footageOverlap } = await import("../server/diversity.js");
    const { parseCaptionCues } = await import("../server/edit-plan.js");
    await mkdir(paths.analysis, { recursive: true });
    const silent = path.join(directory, "silent.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
      "-i", "color=navy:size=160x90:rate=2:duration=90", "-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", silent]);
    let providerCalls: string[] = [];
    const mocked = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      assert.equal(String(input), "https://api.deepseek.com/chat/completions", "No unplanned external request is allowed");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer history-planning-test-key");
      const request = JSON.parse(String(init?.body));
      const prompt = JSON.parse(request.messages[1].content).input;
      providerCalls.push(prompt.task);
      let reply: unknown;
      if (prompt.task.startsWith("Find complete")) reply = { ideas: [{
        firstUnit: 1, lastUnit: 3, kind: "question-answer", summary: "Shutter speed reduces motion blur while focus still needs attention",
        setupUnit: 1, payoffUnit: 2, qualificationUnits: [3],
      }] };
      else if (prompt.task.startsWith("Choose one complete")) {
        assert.ok(prompt.candidates.every((candidate: { transcript: string }) => candidate.transcript.includes("missed focus")),
          "Historical semantic ideas must retain their qualification instead of being replaced by an unrelated sentence");
        reply = { windowIndex: 0 };
      } else if (prompt.task.startsWith("Write the on-screen packaging")) {
        assert.match(prompt.selectedExcerpt.transcript, /faster shutter speed/u);
        reply = { hook: "Shutter speed helps motion blur, not focus", callouts: [], narration: "" };
      } else assert.fail(`Unexpected model task: ${prompt.task}`);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] });
    });
    restoreFetch = () => mocked.mock.restore();

    const sourceFor = async (transcript?: Transcript): Promise<StoredSource> => {
      const source: StoredSource = { id: randomUUID(), name: "source.mp4", size: 12345,
        duration: transcript?.duration ?? 90, width: 160, height: 90, fps: 2, hasAudio: Boolean(transcript),
        createdAt: new Date().toISOString(), thumbnailUrl: "", url: "", filePath: silent, thumbnailPath: path.join(directory, "thumbnail.jpg") };
      if (transcript) await writeFile(path.join(paths.analysis, `${source.id}.json`), JSON.stringify({
        key: `v1:history-planning-test:${source.size}:${source.duration}`, transcript,
      }));
      return source;
    };
    const jobFor = (source: StoredSource, changes: Partial<StoredJob> = {}): StoredJob => ({
      id: randomUUID(), batchId: "current-batch", sourceId: source.id, sourceName: source.name, variant: 1,
      status: "queued", progress: 0, settings: { ...DEFAULT_SETTINGS },
      // This fixture exercises editorial selection with a synthetic transcript;
      // actual source-caption detection has separate real-media coverage.
      auto: { ...DEFAULT_AUTO_OPTIONS, captions: "add", targetDuration: 30, supportingVisuals: "off" },
      createdAt: new Date().toISOString(), outputPath: path.join(directory, `${randomUUID()}.mp4`), ...changes,
    });
    const prepare = async (source: StoredSource, historyPlans: EditorialPlan[] = [], previous: StoredJob[] = [], overrides: Partial<StoredJob> = {}) => {
      const workDir = path.join(directory, randomUUID());
      await mkdir(workDir);
      return prepareAutoRemix({ source, job: jobFor(source, overrides), workDir, previous, historyPlans,
        signal: new AbortController().signal, onPhase: () => undefined });
    };
    const historyFrom = (results: Awaited<ReturnType<typeof prepare>>[]): EditorialPlan[] =>
      results.map(result => ({ cuts: structuredClone(result.settings.segments!) }));
    const recordedAlternatives = async (source: StoredSource) => {
      const completed: StoredJob[] = [];
      const results: Awaited<ReturnType<typeof prepare>>[] = [];
      for (let variant = 1; variant <= MAX_AUTO_VERSIONS + 1; variant++) {
        try {
          const result = await prepare(source, [], completed, { variant });
          results.push(result);
          completed.push(jobFor(source, { variant, status: "completed", settings: result.settings }));
        } catch (error) {
          if (error instanceof AutoSkipError) return results;
          throw error;
        }
      }
      assert.fail("The bounded fixture should exhaust its same-batch alternatives");
    };

    await t.test("full-video mode preserves every spoken section and pause regardless of length, pacing, angles or prior exports", async () => {
      config.aiEnabled = true;
      providerCalls = [];
      try {
        for (const duration of [15, 30, 50.966667]) {
          const transcript: Transcript = { language: "en", duration, segments: [
            speech(1, 3, "Keep the opening explanation."),
            speech(duration - 4, duration - 1, "Keep the final qualification too."),
          ] };
          const source = await sourceFor(transcript);
          const cuts = [{ start: 0, end: duration }];
          const sibling = jobFor(source, { status: "completed", settings: { ...DEFAULT_SETTINGS, segments: cuts } });
          const result = await prepare(source, [{ cuts }], [sibling], { auto: {
            ...DEFAULT_AUTO_OPTIONS, durationMode: "full", targetDuration: 5, versionMode: "angles",
            pacing: { mode: "tight", minimumPause: 0.9, keepPause: 0.35, removeFillers: true }, narration: true, captions: "add", audio: "off", supportingVisuals: "off",
          } });
          assert.deepEqual(result.settings.segments, cuts);
          assert.equal(result.settings.speed, 1);
          assert.equal(result.settings.smoothCuts, false);
          assert.equal(result.summary.outputDuration, duration);
          assert.equal(result.summary.narration, false);
          assert.equal(result.audioPath, undefined);
          assert.equal(result.summary.usedAI, false);
          assert.equal(result.settings.hookText, "");
          const captions = parseCaptionCues(await readFile(result.subtitlePath!, "utf8"));
          assert.match(captions.map(cue => cue.text).join(" "), /opening explanation.*final qualification/u);
          assert.ok(captions.at(-1)!.start >= duration - 4, "Captions keep the original pauses and timing");
          assert.equal(providerCalls.length, 0, "Full-video mode does not request excerpt selection or rewritten speech");
        }
      } finally { config.aiEnabled = false; }
    });
    await t.test("a fully used short source can be edited in a new batch with a visible history advisory", async () => {
      const transcript: Transcript = { language: "en", duration: 20, segments: [
        speech(1, 7, "A faster shutter speed reduces motion blur when photographing a moving subject."),
      ] };
      const source = await sourceFor(transcript);
      const original = await prepare(source);
      const result = await prepare(source, historyFrom([original]));
      assert.equal(result.summary.transcriptAvailable, true);
      assert.equal(result.summary.usedAI, false);
      assert.ok(result.settings.segments!.length > 0);
      assert.ok(cutsDuration(result.settings.segments!) <= 30);
      assert.ok(result.notes.some(note => reused.test(note)));
      assert.equal(footageOverlap(result.settings.segments!, original.settings.segments!), 1);
      assert.match(await readFile(result.subtitlePath!, "utf8"), /faster shutter speed/u);
      assert.equal(providerCalls.length, 0);
    });
    await t.test("exhausted sentence selections fall back to historical speech instead of silently switching to scenes", async () => {
      const source = await sourceFor({ language: "en", duration: 90, segments: [
        speech(2, 8, "Set a faster shutter speed to preserve detail in a moving subject."),
        speech(65, 71, "Use a tripod to prevent the camera from moving during the exposure."),
      ] });
      const previous = await recordedAlternatives(source);
      assert.equal(previous.length, 2, "Both complete spoken alternatives were already exported");
      const result = await prepare(source, historyFrom(previous));
      assert.equal(result.summary.transcriptAvailable, true);
      assert.ok(result.subtitlePath);
      assert.ok(result.settings.segments!.every(cut => (cut.start >= 1.8 && cut.end <= 8.3) || (cut.start >= 64.8 && cut.end <= 71.3)));
      assert.ok(result.notes.some(note => reused.test(note)));
      assert.equal(result.notes.some(note => /No usable spoken excerpt/u.test(note)), false);
    });
    await t.test("an unused spoken excerpt is still preferred when one remains", async () => {
      const source = await sourceFor({ language: "en", duration: 90, segments: [
        speech(2, 8, "A faster shutter speed freezes motion from the moving subject."),
        speech(65, 71, "A tripod steadies the camera during an exposure in low light."),
      ] });
      const first = await prepare(source);
      const prior = first.settings.segments!.some(cut => cut.start < 10) ? first : await prepare(source, [], [], { variant: 2 });
      assert.ok(prior.settings.segments!.every(cut => cut.end < 10), "The prior export contains only the opening shutter-speed idea");
      const result = await prepare(source, historyFrom([prior]));
      assert.ok(result.settings.segments!.every(cut => cut.start > 60), "History should steer the first selection toward unused source material");
      assert.equal(result.notes.some(note => reused.test(note)), false);
      assert.equal(footageOverlap(result.settings.segments!, prior.settings.segments!), 0);
      assert.match(await readFile(result.subtitlePath!, "utf8"), /tripod/u);
    });
    await t.test("scene-based planning reuses an exhausted source with an advisory", async () => {
      const source = await sourceFor();
      const previous = await recordedAlternatives(source);
      assert.ok(previous.length > 1);
      const result = await prepare(source, historyFrom(previous));
      assert.equal(result.summary.transcriptAvailable, false);
      assert.ok(result.settings.segments!.length > 0);
      assert.ok(cutsDuration(result.settings.segments!) <= 30.001);
      assert.ok(result.settings.segments!.every(cut => cut.start >= 0 && cut.end <= source.duration));
      assert.ok(result.notes.some(note => reused.test(note)));
    });
    await t.test("history-exhausted AI ideas retain their complete question, answer and caveat", async () => {
      config.aiEnabled = true; providerCalls = [];
      try {
        const source = await sourceFor({ language: "en", duration: 90, segments: [
          speech(0, 2, "Welcome back to the show."),
          speech(6, 8, "How can I take sharper photos?"),
          speech(9, 11, "A faster shutter speed reduces motion blur."),
          speech(12, 14, "However, it does not correct missed focus."),
          speech(40, 44, "Please subscribe for the next episode."),
        ] });
        const original = await prepare(source);
        assert.equal(providerCalls.length, 3, "Initial discovery, selection and packaging requests are mocked");
        providerCalls = [];
        const result = await prepare(source, historyFrom([original]));
        assert.equal(result.summary.usedAI, true);
        assert.equal(providerCalls.length, 2, "Cached semantic ideas are selected and packaged again after the source was already used");
        assert.ok(result.notes.some(note => reused.test(note)));
        assert.ok(result.notes.some(note => /Selected idea:.*focus/u.test(note)));
        const captions = parseCaptionCues(await readFile(result.subtitlePath!, "utf8")).map(cue => cue.text).join(" ");
        assert.match(captions, /sharper photos/u); assert.match(captions, /faster shutter speed/u); assert.match(captions, /missed focus/u);
        assert.doesNotMatch(captions, /subscribe|Welcome/u);
        assert.ok(result.settings.segments![0]!.start >= 5.8);
        assert.ok(result.settings.segments!.at(-1)!.end <= 14.3);
      } finally { config.aiEnabled = false; }
    });
    await t.test("same-batch speech repeats stay skipped until an explicit repeat retry is requested", async () => {
      const source = await sourceFor({ language: "en", duration: 90, segments: [
        speech(2, 8, "Set the shutter speed faster to freeze a moving subject in your photo."),
      ] });
      const first = await prepare(source);
      const sibling = jobFor(source, { status: "completed", settings: first.settings });
      await assert.rejects(prepare(source, [], [sibling]), error => error instanceof AutoSkipError);
      const retried = await prepare(source, historyFrom([first]), [sibling], { allowRepeatedFootage: true });
      assert.deepEqual(retried.settings.segments, first.settings.segments);
      assert.equal(retried.summary.transcriptAvailable, true);
      assert.ok(retried.notes.some(note => reused.test(note)));
    });
    await t.test("the early same-batch guard for short sources also honors explicit repeat retry", async () => {
      const source = await sourceFor({ language: "en", duration: 20, segments: [
        speech(1, 6, "Keep the camera steady to avoid motion blur in the final image."),
      ] });
      const first = await prepare(source);
      const sibling = jobFor(source, { status: "completed", settings: first.settings });
      await assert.rejects(prepare(source, [], [sibling]), error => error instanceof AutoSkipError);
      const retried = await prepare(source, [], [sibling], { allowRepeatedFootage: true });
      assert.deepEqual(retried.settings.segments, first.settings.segments);
    });
  } finally {
    restoreFetch?.();
    process.chdir(previousCwd);
    for (const key of environmentKeys) {
      const saved = savedEnvironment[key];
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
