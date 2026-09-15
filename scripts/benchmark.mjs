import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS } from "../shared/types.ts";
import { textLayoutIssues } from "../shared/framing.ts";
import { runLocal } from "../server/auto-process.ts";
import { inspectBrollWindows } from "../server/broll-motion.ts";
import { probeMedia, renderVideo } from "../server/engine.ts";
import { inspectExport } from "../server/quality.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const args = process.argv.slice(2);
let outputDirectory = path.join(root, "output", "benchmark");
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
let staging;

try {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--"))
      outputDirectory = path.resolve(args[++index]);
    else if (args[index] === "--help") {
      console.log("Usage: npm run benchmark -- [--output DIRECTORY]\nGenerates synthetic local video diagnostics and runs production checks. No AI, ASR or network calls.\nOnly named benchmark artifacts are replaced; other files are preserved.");
      process.exit(0);
    } else throw new Error("Unknown or incomplete argument. Use --help or --output DIRECTORY.");
  }
  const manifestText = await readFile(path.join(root, "benchmarks", "cases.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const artifactNames = [...new Set(manifest.automatedCases.flatMap(item => item.files)), "benchmark-cases.json", "benchmark-report.json"];
  // Stage files and replace only declared regular files. Never recursively
  // clear the selected output directory or follow an artifact symlink.
  if (artifactNames.some(name => !/^benchmark-[a-z-]+\.(mp4|srt|json)$/u.test(name)))
    throw new Error("The benchmark manifest contains an invalid artifact filename.");
  await mkdir(outputDirectory, { recursive: true });
  for (const name of artifactNames) {
    try {
      if (!(await lstat(path.join(outputDirectory, name))).isFile())
        throw new Error("Refusing to replace a non-regular benchmark artifact: " + name);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  staging = await mkdtemp(path.join(outputDirectory, ".benchmark-"));
  const file = name => path.join(staging, "benchmark-" + name + ".mp4");
  const tone = "sine=frequency=440:sample_rate=48000";
  const portrait = "testsrc2=size=180x320:rate=24";
  const fixture = async (name, video, audio, duration = 4) => {
    await runLocal("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-threads", "1", "-f", "lavfi", "-i", video,
      ...(audio ? ["-f", "lavfi", "-i", audio] : ["-an"]),
      "-t", String(duration), "-c:v", "libx264", "-threads", "1",
      "-filter_threads", "1", "-filter_complex_threads", "1", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac"] : []), file(name),
    ], { signal, timeout: 15_000 });
  };
  const { stdout: ffmpegVersion } = await runLocal("ffmpeg", ["-version"], { signal, timeout: 5_000 });
  await fixture("motion-portrait", portrait, tone);
  await fixture("static-image", portrait + ",select=eq(n\\,0),loop=loop=-1:size=1:start=0,setpts=N/24/TB", tone);
  await fixture("late-motion", portrait + ":duration=4,tpad=start_duration=8:start_mode=clone", undefined, 12);
  await fixture("cropped-motion", "testsrc2=size=320x180:rate=24,drawbox=x=96:y=0:w=128:h=180:color=gray:t=fill");
  await fixture("missing-audio", portrait);
  await fixture("quiet-audio", portrait, tone + ",volume=0.00001");
  await fixture("black-frames", "color=black:size=180x320:rate=24", tone);
  await fixture("framing-source", "color=blue:size=360x180:rate=24,drawbox=x=0:y=0:w=120:h=180:color=red:t=fill,drawbox=x=240:y=0:w=120:h=180:color=lime:t=fill", tone);

  const source = await probeMedia(file("motion-portrait"), signal);
  const media = async name => ({ ...await probeMedia(file(name), signal), filePath: file(name) });
  const motion = async (name, aspect = 9 / 16, exact) => inspectBrollWindows(await media(name), aspect, signal, exact);
  const quality = (name, extra = {}) => inspectExport({ output: file(name), source,
    settings: { ...DEFAULT_SETTINGS }, signal, ...extra });
  const results = [];
  const check = (id, passed, expected, observed) => ({ id, passed, expected, observed });
  const record = (id, checks, evidence = {}) => {
    results.push({ id, status: checks.every(item => item.passed) ? "pass" : "fail", checks, evidence });
  };
  const issueCodes = report => report.issues.map(issue => issue.code);

  const movingWindows = await motion("motion-portrait");
  const movingQuality = await quality("motion-portrait");
  record("tech-motion-portrait", [
    check("moving-windows", movingWindows.length > 0 && movingWindows.length <= 3, "1–3 moving intervals", movingWindows.length),
    check("portrait-retention", movingWindows.length > 0 && movingWindows.every(window => window.cropRetention === 1), "full crop retention", movingWindows.map(window => window.cropRetention)),
    check("healthy-export", movingQuality.status === "pass", "pass", movingQuality.status),
  ], { windows: movingWindows, issueCodes: issueCodes(movingQuality) });

  const stillWindows = await motion("static-image");
  const stillQuality = await quality("static-image");
  record("tech-static-mp4", [
    check("still-rejection", stillWindows.length === 0, "zero moving intervals", stillWindows.length),
    check("freeze-review", stillQuality.status === "review" && issueCodes(stillQuality).includes("frozen-frames"), "frozen-frames review", issueCodes(stillQuality)),
  ]);

  const lateWindows = await motion("late-motion");
  const openingWindows = await motion("late-motion", 9 / 16, { sourceStart: 0, duration: 2.4 });
  record("tech-late-motion", [
    check("later-shot", lateWindows.length > 0 && lateWindows[0].sourceStart >= 8, "best interval starts at or after 8 seconds", lateWindows[0]?.sourceStart ?? null),
    check("exact-opening-rejection", openingWindows.length === 0, "zero moving intervals in first 2.4 seconds", openingWindows.length),
  ], { windows: lateWindows });

  const croppedWindows = await motion("cropped-motion");
  const wideWindows = await motion("cropped-motion", 16 / 9);
  record("tech-crop-action", [
    check("cropped-action-rejection", croppedWindows.length === 0, "zero moving portrait intervals", croppedWindows.length),
    check("wide-action-retained", wideWindows.length > 0, "moving landscape interval", wideWindows.length),
  ], { landscapeWindows: wideWindows });

  for (const [id, name, code] of [
    ["tech-audio-missing", "missing-audio", "missing-audio"],
    ["tech-audio-quiet", "quiet-audio", "near-silent-audio"],
  ]) {
    const report = await quality(name);
    record(id, [check("expected-review", report.status === "review" && issueCodes(report).includes(code), code + " review", issueCodes(report))]);
  }
  const dark = await quality("black-frames", { supportingVisuals: [{ path: file("black-frames"), kind: "graphic", label: "Planned card", sourceStart: 0, start: 0, end: 4 }] });
  record("tech-black-frames", [check("black-review", dark.status === "review" && issueCodes(dark).includes("black-frames"), "black-frames review despite planned graphic", issueCodes(dark))]);

  const framingSource = await probeMedia(file("framing-source"), signal);
  const framingSettings = { ...DEFAULT_SETTINGS, aspect: "9:16", speed: 2, segments: [
    { start: 2, end: 4, focalPoint: { x: 0.15, y: 0.5 } },
    { start: 0, end: 2, focalPoint: { x: 0.85, y: 0.5 } },
  ] };
  await renderVideo({ input: file("framing-source"), output: file("framing-result"), source: framingSource,
    settings: framingSettings, workDir: path.join(staging, ".render-work"), signal, onProgress: () => undefined });
  const pixel = async time => {
    const { stdout } = await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
      "-ss", String(time), "-i", file("framing-result"), "-frames:v", "1", "-vf", "scale=1:1", "-filter_threads", "1",
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 1024 * 1024, timeout: 10_000, signal });
    return [...stdout];
  };
  const first = await pixel(0.4), second = await pixel(1.4);
  const framed = await probeMedia(file("framing-result"), signal);
  record("tech-subject-framing", [
    check("first-red-subject", first[0] > 220 && first[1] < 25 && first[2] < 25, "red picture", first),
    check("second-green-subject", second[1] > 220 && second[0] < 25 && second[2] < 25, "green picture", second),
    check("accelerated-duration", Math.abs(framed.duration - 2) < 0.1, "2 seconds ±0.1", framed.duration),
  ]);

  const captionPath = path.join(staging, "benchmark-caption.srt");
  await writeFile(captionPath, "1\n00:00:00,200 --> 00:00:01,800\nThis caption is too close to the hook\n", "utf8");
  const caption = { id: "cue-1", start: 0.2, end: 1.8, text: "This caption is too close to the hook" };
  const overlapSettings = { ...DEFAULT_SETTINGS, trimEnd: 2, hookText: "A clear opening", hookDuration: 2, captionStyle: { fontSize: 40, bottomPercent: 70 } };
  const overlapIssues = textLayoutIssues({ settings: overlapSettings, captions: [caption] }, 9 / 16);
  const safeIssues = textLayoutIssues({ settings: { ...overlapSettings, captionStyle: { fontSize: 18, bottomPercent: 20 } }, captions: [caption] }, 9 / 16);
  await renderVideo({ input: file("motion-portrait"), output: file("text-overlap"), source,
    settings: overlapSettings, subtitlePath: captionPath, workDir: path.join(staging, ".render-work"), signal, onProgress: () => undefined });
  record("tech-text-layout", [
    check("collision-warning", overlapIssues.some(issue => issue.code === "text-collision" && issue.start === 0.2), "timed text-collision", overlapIssues.map(issue => issue.code)),
    check("safe-placement", safeIssues.length === 0, "no layout warning", safeIssues.map(issue => issue.code)),
  ]);

  if (JSON.stringify(results.map(item => item.id).sort()) !== JSON.stringify(manifest.automatedCases.map(item => item.id).sort()))
    throw new Error("The benchmark runner and case manifest disagree.");
  const fixtures = [];
  for (const name of artifactNames.filter(name => name.endsWith(".mp4"))) {
    const filename = path.join(staging, name);
    fixtures.push({ file: name, ...await probeMedia(filename, signal), sizeBytes: (await stat(filename)).size });
  }
  const failed = results.filter(item => item.status !== "pass").length;
  const report = { version: 1, manifestVersion: manifest.version, generatedAt: new Date().toISOString(),
    status: failed ? "fail" : "pass", scope: "synthetic-local-diagnostics", networkCalls: 0,
    versions: { node: process.versions.node, ffmpeg: ffmpegVersion.split("\n")[0] },
    summary: { total: results.length, passed: results.length - failed, failed }, cases: results, fixtures,
    humanReview: { status: "not-run", caseIds: manifest.humanCases.map(item => item.id), reason: manifest.syntheticLimit } };
  await writeFile(path.join(staging, "benchmark-cases.json"), manifestText, "utf8");
  await writeFile(path.join(staging, "benchmark-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  signal.throwIfAborted();
  for (const name of artifactNames) await rename(path.join(staging, name), path.join(outputDirectory, name));
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ version: 1, status: "error", message: signal.aborted ? "Benchmark cancelled or exceeded its 90-second limit." : error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
