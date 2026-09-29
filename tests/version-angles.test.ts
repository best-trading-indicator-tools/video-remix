import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_AUTO_OPTIONS, DEFAULT_SETTINGS, type AutoOptions, type EditSegment, type Transcript } from "../shared/types.js";
import { conclusionTeaser, MAX_ANGLE_VERSIONS, numberedCallouts, versionAngle } from "../shared/version-angles.js";
import { CAPTION_PRESETS } from "../shared/caption-style.js";
import { autoBatchSchema, batchSchema } from "../server/schema.js";
import type { StoredJob, StoredSource } from "../server/store.js";

const exec = promisify(execFile);
const timed = (start: number, text: string, step = 0.4) => {
  const words = text.split(" ").map((token, index) => ({ start: Number((start + index * step).toFixed(3)),
    end: Number((start + index * step + step * 0.8).toFixed(3)), word: ` ${token}`, probability: 0.95 }));
  return { start, end: words.at(-1)!.end, text, words };
};
// Word ends: “launch.” 4.72 · “users.” 8.92 · “harder.” 14.62.
const talk: Transcript = { language: "en", duration: 30, segments: [
  timed(2, "Most apps charge too little at launch."),
  timed(5, "Test a higher price early before you have many users."),
  timed(9.5, "You can always lower a price later but raising it is much harder."),
] };
const whole: EditSegment[] = [{ start: 1.9, end: 14.8 }];
const close = (cuts: EditSegment[] | undefined, expected: [number, number][]) => {
  assert.equal(cuts?.length, expected.length, JSON.stringify(cuts));
  cuts!.forEach((cut, index) => assert.ok(Math.abs(cut.start - expected[index]![0]) < 1e-6 && Math.abs(cut.end - expected[index]![1]) < 1e-6, JSON.stringify(cuts)));
};

test("angles apply to the first four versions only when chosen", () => {
  const angles = { versionMode: "angles" } as const;
  assert.deepEqual([1, 2, 3, 4, 5].map(variant => versionAngle(angles, variant)), ["classic", "payoff", "question", "points", undefined]);
  assert.equal(versionAngle({}, 2), undefined);
  assert.equal(versionAngle({ versionMode: "moments" }, 2), undefined);
  assert.equal(MAX_ANGLE_VERSIONS, 4);
});

test("the conclusion teaser replays the final sentence inside the excerpt's own cuts", () => {
  const teaser = conclusionTeaser(talk, whole, undefined, 30);
  assert.equal(teaser?.text, "You can always lower a price later but raising it is much harder.");
  close(teaser?.cuts, [[9.38, 14.8]]);
  assert.ok(Math.abs(teaser!.duration - 5.42) < 1e-6);
  const quoted = conclusionTeaser(talk, whole, "test a higher price early before you have many users", 30);
  close(quoted?.cuts, [[4.88, 9.12]]);
  assert.equal(quoted?.text, "Test a higher price early before you have many users.", "A found quote wins");
  // Pacing removed the pause inside the conclusion; replaying it must not bring the pause back.
  const pausing: Transcript = { ...talk, segments: [...talk.segments.slice(0, 2),
    timed(9.5, "You can always lower a price later,"), timed(13.2, "but raising it is much harder.")] };
  const paced = conclusionTeaser(pausing, [{ start: 1.9, end: 12.4 }, { start: 13, end: 15.7 }], undefined, 30);
  close(paced?.cuts, [[9.38, 12.4], [13, 15.7]]);
  assert.equal(paced?.text, "You can always lower a price later, but raising it is much harder.");
  const tooLong = conclusionTeaser(talk, whole, "most apps charge too little at launch test a higher price early before you have many users", 30);
  assert.match(tooLong!.text, /^You can always/u, "An overlong quote falls back to the final sentence");
});

test("the teaser falls back to the final sentence and refuses openings, single sentences and overlong results", () => {
  assert.match(conclusionTeaser(talk, whole, "Most apps charge too little at launch", 30)!.text, /^You can always/u, "Quoting the opening is not a conclusion");
  assert.match(conclusionTeaser(talk, whole, "words that were never spoken", 30)!.text, /^You can always/u);
  assert.equal(conclusionTeaser(talk, whole, undefined, 3), null, "No room within the duration limit");
  assert.equal(conclusionTeaser(talk, [{ start: 9.3, end: 14.8 }], undefined, 30), null, "A one-sentence excerpt has nothing to lead into");
  const long: Transcript = { language: "en", duration: 30, segments: [timed(0, "Start here."), timed(2, Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ") + ".")] };
  assert.equal(conclusionTeaser(long, [{ start: 0, end: 16 }], undefined, 30), null, "A conclusion longer than seven seconds is not a teaser");
});

test("without word timings only whole recognized sentences become teasers", () => {
  const plain: Transcript = { language: "en", duration: 20, segments: [
    { start: 1, end: 4, text: "First point here.", words: [] },
    { start: 5, end: 8, text: "The main takeaway, stated clearly.", words: [] },
    { start: 9, end: 12, text: "A closing remark follows.", words: [] },
  ] };
  close(conclusionTeaser(plain, [{ start: 0, end: 13 }], undefined, 20)?.cuts, [[9, 12]]);
  close(conclusionTeaser(plain, [{ start: 0, end: 13 }], "the main takeaway stated clearly", 20)?.cuts, [[5, 8]]);
  assert.equal(conclusionTeaser(plain, [{ start: 4.5, end: 8.5 }], undefined, 20), null);
});

test("key points are numbered in spoken order", () => {
  assert.deepEqual(numberedCallouts([{ text: "Later", start: 5, end: 6 }, { text: "Sooner", start: 1, end: 2 }]).map(item => item.text), ["1. Sooner", "2. Later"]);
});

test("version mode is validated and randomized manual copies are refused", () => {
  const sourceId = randomUUID();
  assert.ok(autoBatchSchema.safeParse({ items: [{ sourceId, variants: 4, options: { versionMode: "angles" } }] }).success);
  assert.equal(autoBatchSchema.safeParse({ items: [{ sourceId, variants: 4, options: { versionMode: "remix" } }] }).success, false);
  const manual = { items: [{ sourceId, settings: DEFAULT_SETTINGS }], variants: 1 };
  assert.ok(batchSchema.safeParse({ ...manual, randomize: false }).success, "Older clients may still send randomize: false");
  const refused = batchSchema.safeParse({ ...manual, randomize: true });
  assert.equal(refused.success, false);
  assert.match(JSON.stringify(refused.error?.issues), /New angles/u);
});

test("new angles reuse version 1's moment with a different opening, text and caption look", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "version-angles-"));
  const previousCwd = process.cwd();
  const keys = ["DATA_DIR", "AUTO_AI", "AUTO_LOCAL_AI", "DEEPSEEK_API_KEY", "DEEPSEEK_TEXT_MODEL", "PIXABAY_API_KEY", "PEXELS_API_KEY", "WHISPER_MODEL", "WHISPER_CACHE_DIR"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let restoreFetch: (() => void) | undefined;
  let aiConfig: { aiEnabled: boolean } | undefined;
  try {
    // Only the availability probe runs; every speech path reads the cached transcript.
    await mkdir(path.join(directory, ".venv", "bin"), { recursive: true });
    await mkdir(path.join(directory, "scripts"), { recursive: true });
    const python = path.join(directory, ".venv", "bin", "python");
    await writeFile(python, `#!${process.execPath}\nif (!process.argv.includes('--check')) { process.stderr.write('Unexpected transcription'); process.exit(1); }\nprocess.stdout.write(JSON.stringify({available:true}));\n`);
    await chmod(python, 0o700);
    await writeFile(path.join(directory, "scripts", "transcribe.py"), "# Availability-only fixture\n");
    process.chdir(directory);
    Object.assign(process.env, { DATA_DIR: path.join(directory, "data"), AUTO_AI: "false", AUTO_LOCAL_AI: "false",
      DEEPSEEK_API_KEY: "angles-test-key", DEEPSEEK_TEXT_MODEL: "angles-test-model", PEXELS_API_KEY: "", PIXABAY_API_KEY: "",
      WHISPER_MODEL: "angles-test", WHISPER_CACHE_DIR: path.join(directory, "models") });
    const { config, paths } = await import("../server/config.js");
    aiConfig = config;
    const { AutoSkipError, prepareAutoRemix } = await import("../server/auto.js");
    const { parseCaptionCues } = await import("../server/edit-plan.js");
    await mkdir(paths.analysis, { recursive: true });
    const silent = path.join(directory, "silent.mp4");
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
      "-i", "color=navy:size=160x90:rate=2:duration=30", "-an", "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", silent]);
    let calls: string[] = [];
    const mocked = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      assert.equal(String(input), "https://api.deepseek.com/chat/completions", "No unplanned external request is allowed");
      const prompt = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).input;
      const angle = (prompt.instructions as string[] | undefined)?.find(line => line.startsWith("Angle:"))?.split(".")[0];
      const kind = prompt.task.startsWith("Find complete") ? "discovery" : prompt.task.startsWith("Choose one complete") ? "selection" : "packaging";
      calls.push(angle ? `${kind} · ${angle}` : kind);
      let reply: unknown;
      if (prompt.task.startsWith("Find complete")) reply = { ideas: [{ firstUnit: 0, lastUnit: 2, kind: "explanation",
        summary: "Launch pricing is easier to lower than to raise", setupUnit: 0, payoffUnit: 2, qualificationUnits: [] }] };
      else if (prompt.task.startsWith("Choose one complete")) reply = { windowIndex: 0 };
      else if (angle === "Angle: conclusion first") reply = { hook: "Raising a price later is much harder", callouts: [],
        openingQuote: "You can always lower a price later but raising it is much harder" };
      else if (angle === "Angle: question first") reply = { hook: "Why test a higher price early?", callouts: [] };
      else if (angle === "Angle: key points") reply = { hook: "Two pricing rules to remember", callouts: ["Lower a price later", "Test a higher price early"] };
      else if (prompt.task.startsWith("Write the on-screen packaging")) reply = { hook: "Test a higher price early", callouts: [], narration: "" };
      else assert.fail(`Unexpected model task: ${prompt.task}`);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(reply) } }] });
    });
    restoreFetch = () => mocked.mock.restore();

    const source: StoredSource = { id: randomUUID(), name: "pricing.mp4", size: 4321, duration: 30, width: 160, height: 90, fps: 2,
      hasAudio: true, createdAt: new Date().toISOString(), thumbnailUrl: "", url: "", filePath: silent, thumbnailPath: path.join(directory, "thumbnail.jpg") };
    await writeFile(path.join(paths.analysis, `${source.id}.json`), JSON.stringify({ key: `v1:angles-test:${source.size}:${source.duration}`, transcript: talk }));
    const angles: AutoOptions = { ...DEFAULT_AUTO_OPTIONS, captions: "add", targetDuration: 30, supportingVisuals: "off", versionMode: "angles" };
    const jobFor = (changes: Partial<StoredJob> = {}): StoredJob => ({
      id: randomUUID(), batchId: "angle-batch", sourceId: source.id, sourceName: source.name, variant: 1,
      status: "queued", progress: 0, settings: { ...DEFAULT_SETTINGS }, auto: angles,
      createdAt: new Date().toISOString(), outputPath: path.join(directory, `${randomUUID()}.mp4`), ...changes,
    });
    const prepare = async (changes: Partial<StoredJob>, previous: StoredJob[] = []) => {
      const workDir = path.join(directory, randomUUID());
      await mkdir(workDir);
      return prepareAutoRemix({ source, job: jobFor(changes), workDir, previous, signal: new AbortController().signal, onPhase: () => undefined });
    };
    const style = (id: string) => CAPTION_PRESETS.find(preset => preset.id === id)!.style;

    config.aiEnabled = true;
    const lead = await prepare({ variant: 1 });
    assert.ok(lead.notes.some(note => /^Angle: classic/u.test(note)));
    assert.equal(lead.settings.hookText, "Test a higher price early");
    assert.equal(lead.settings.captionStyle, undefined, "Version 1 keeps the default caption look");
    const leadCuts = lead.settings.segments!;
    const completed = jobFor({ variant: 1, status: "completed", settings: lead.settings });

    await t.test("conclusion first replays the quoted conclusion before the whole moment", async () => {
      calls = [];
      const result = await prepare({ variant: 2 }, [completed]);
      assert.deepEqual(calls, ["packaging · Angle: conclusion first"], "No new discovery or selection request");
      const cuts = result.settings.segments!;
      assert.deepEqual(cuts.slice(cuts.length - leadCuts.length), leadCuts);
      const teaser = cuts.slice(0, cuts.length - leadCuts.length);
      assert.ok(teaser.length >= 1 && teaser.every(cut => cut.start >= 9.2 && cut.end <= 14.9), JSON.stringify(teaser));
      assert.equal(result.settings.hookText, "Raising a price later is much harder");
      assert.deepEqual(result.settings.captionStyle, style("punch"));
      assert.ok(result.notes.some(note => /^Angle: conclusion first\. Opens with/u.test(note)));
      assert.ok(result.summary.outputDuration <= 30.001);
      const captions = parseCaptionCues(await readFile(result.subtitlePath!, "utf8")).map(cue => cue.text).join(" ");
      assert.equal(captions.match(/much harder/gu)?.length, 2, "The replayed conclusion is captioned both times");
    });
    await t.test("question first keeps the footage and opens on the question", async () => {
      calls = [];
      const result = await prepare({ variant: 3 }, [completed]);
      assert.deepEqual(calls, ["packaging · Angle: question first"]);
      assert.deepEqual(result.settings.segments, leadCuts);
      assert.equal(result.settings.hookText, "Why test a higher price early?");
      assert.deepEqual(result.settings.captionStyle, style("editorial"));
    });
    await t.test("key points are numbered in spoken order", async () => {
      const result = await prepare({ variant: 4 }, [completed]);
      assert.deepEqual(result.settings.segments, leadCuts);
      assert.deepEqual(result.settings.callouts!.map(callout => callout.text), ["1. Test a higher price early", "2. Lower a price later"]);
      assert.deepEqual(result.settings.captionStyle, style("box"));
    });
    await t.test("a caption style you chose applies to every angle", async () => {
      const chosen = style("clean");
      const result = await prepare({ variant: 3, auto: { ...angles, captionStyle: chosen } }, [jobFor({ variant: 1, status: "completed", settings: lead.settings, auto: { ...angles, captionStyle: chosen } })]);
      assert.deepEqual(result.settings.captionStyle, chosen);
    });
    await t.test("without version 1's moment the version chooses another moment and says so", async () => {
      calls = [];
      const result = await prepare({ variant: 2 });
      assert.ok(result.notes.some(note => /Version 1 did not choose a moment/u.test(note)));
      assert.ok(calls.includes("selection"), `The normal selection runs: ${calls.join(", ")} · ${result.notes.join(" | ")}`);
    });
    await t.test("without AI the conclusion teaser still differs and speaks its own hook", async () => {
      config.aiEnabled = false;
      try {
        const result = await prepare({ variant: 2 }, [completed]);
        const cuts = result.settings.segments!;
        assert.equal(cuts.length, leadCuts.length + 1);
        assert.ok(cuts[0]!.start >= 9.2 && cuts[0]!.end <= 14.9);
        assert.match(result.settings.hookText, /^You can always lower a price later/u);
        assert.equal(result.summary.usedAI, false);
      } finally { config.aiEnabled = true; }
    });
    await t.test("an angle that cannot differ explains why instead of repeating a short source", async () => {
      config.aiEnabled = false;
      try {
        const oneSentence = jobFor({ variant: 1, status: "completed", settings: { ...lead.settings, segments: [{ start: 9.3, end: 14.8 }] } });
        await assert.rejects(prepare({ variant: 2 }, [oneSentence]),
          error => error instanceof AutoSkipError && /no separate concluding sentence.*No duplicate version was made/u.test(error.message));
        await assert.rejects(prepare({ variant: 3 }, [completed]),
          error => error instanceof AutoSkipError && /Question first needs DeepSeek/u.test(error.message));
      } finally { config.aiEnabled = true; }
    });
    await t.test("angle batches keep the original voice", async () => {
      const result = await prepare({ variant: 1, auto: { ...angles, narration: true } });
      assert.equal(result.summary.narration, false);
      assert.ok(result.notes.some(note => /keep the original voice/u.test(note)));
    });
  } finally {
    if (aiConfig) aiConfig.aiEnabled = false;
    restoreFetch?.();
    process.chdir(previousCwd);
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
