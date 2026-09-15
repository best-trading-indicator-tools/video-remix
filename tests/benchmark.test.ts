import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { probeMedia } from "../server/engine.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(root, "scripts", "benchmark.mjs");
const manifest = JSON.parse(await readFile(path.join(root, "benchmarks", "cases.json"), "utf8"));

test("local benchmark exercises real checks, exposes deliberate defects, and preserves unrelated recordings", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-benchmark-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "output with spaces");
  await mkdir(path.join(output, "owned"), { recursive: true });
  const owned = path.join(output, "owned", "my-recording.mp4");
  await writeFile(owned, "Keep this owned recording");
  await writeFile(path.join(output, "review-notes.txt"), "Keep my benchmark notes");
  // A configured provider must not turn this local harness into an API run.
  // Any fetch makes the child fail.
  const guard = path.join(directory, "no-network.mjs");
  await writeFile(guard, "globalThis.fetch = async () => { throw new Error('The local benchmark attempted a network call'); };\n");
  const secret = "benchmark-provider-key-must-not-appear";
  const run = async () => {
    const result = await exec(process.execPath, ["--import", "tsx", "--import", pathToFileURL(guard).href, runner, "--output", output], {
      cwd: root, timeout: 40_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, DEEPSEEK_API_KEY: secret, PEXELS_API_KEY: secret, PIXABAY_API_KEY: secret },
    });
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
    return JSON.parse(result.stdout);
  };
  const report = await run();
  assert.equal(report.status, "pass");
  assert.equal(report.scope, "synthetic-local-diagnostics");
  assert.equal(report.networkCalls, 0);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.total, 9);
  assert.equal(report.humanReview.status, "not-run");
  assert.deepEqual(report.humanReview.caseIds, manifest.humanCases.map((item: { id: string }) => item.id));
  assert.deepEqual(report.cases.map((item: { id: string }) => item.id).sort(),
    manifest.automatedCases.map((item: { id: string }) => item.id).sort());
  const byId = new Map<string, { checks: { id: string; passed: boolean; observed: unknown }[]; evidence: { windows?: { sourceStart: number; motion: number }[] } }>(
    report.cases.map((item: { id: string }) => [item.id, item]),
  );
  const observed = (id: string, check: string) => byId.get(id)!.checks.find(item => item.id === check)!.observed;
  assert.equal(observed("tech-static-mp4", "still-rejection"), 0);
  assert.ok((observed("tech-static-mp4", "freeze-review") as string[]).includes("frozen-frames"));
  assert.ok((observed("tech-audio-missing", "expected-review") as string[]).includes("missing-audio"));
  assert.ok((observed("tech-audio-quiet", "expected-review") as string[]).includes("near-silent-audio"));
  assert.ok((observed("tech-black-frames", "black-review") as string[]).includes("black-frames"));
  assert.ok((observed("tech-late-motion", "later-shot") as number) >= 8);
  assert.equal(observed("tech-crop-action", "cropped-action-rejection"), 0);
  assert.ok((observed("tech-crop-action", "wide-action-retained") as number) > 0);
  assert.deepEqual(observed("tech-text-layout", "safe-placement"), []);
  assert.ok(byId.get("tech-motion-portrait")!.evidence.windows!.every(window => window.motion > 0));
  for (const item of report.cases) assert.ok(item.checks.every((check: { passed: boolean }) => check.passed), JSON.stringify(item));

  // Probe saved artifacts independently: the video and sound really exist.
  const valid = await probeMedia(path.join(output, "benchmark-motion-portrait.mp4"));
  const silent = await probeMedia(path.join(output, "benchmark-missing-audio.mp4"));
  const quiet = await probeMedia(path.join(output, "benchmark-quiet-audio.mp4"));
  const cut = await probeMedia(path.join(output, "benchmark-framing-result.mp4"));
  assert.equal(valid.width, 180);
  assert.equal(valid.height, 320);
  assert.equal(valid.hasAudio, true);
  assert.equal(silent.hasAudio, false);
  assert.equal(quiet.hasAudio, true);
  assert.ok(cut.height > cut.width && Math.abs(cut.duration - 2) < 0.1);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "benchmark-report.json"), "utf8")), report);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "benchmark-cases.json"), "utf8")), manifest);
  const expectedFiles = [...new Set<string>(manifest.automatedCases.flatMap((item: { files: string[] }) => item.files)), "benchmark-cases.json", "benchmark-report.json"];
  for (const name of expectedFiles) assert.ok((await stat(path.join(output, name))).size > 0);
  assert.ok(!(await readdir(output)).some(name => name.startsWith(".benchmark-")), "Staged media must be cleaned");

  // A rerun repairs named generated files while preserving notes and real media.
  await writeFile(path.join(output, "benchmark-motion-portrait.mp4"), "Old generated fixture");
  const repeated = await run();
  assert.equal(repeated.status, "pass");
  assert.deepEqual(repeated.cases, report.cases);
  assert.equal(await readFile(owned, "utf8"), "Keep this owned recording");
  assert.equal(await readFile(path.join(output, "review-notes.txt"), "utf8"), "Keep my benchmark notes");
  assert.equal((await probeMedia(path.join(output, "benchmark-motion-portrait.mp4"))).hasAudio, true);
});

test("benchmark refuses artifact symlinks and invalid arguments before replacing user files", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-benchmark-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "output");
  await mkdir(output);
  const original = path.join(directory, "original.mp4");
  await writeFile(original, "Private original");
  await symlink(original, path.join(output, "benchmark-motion-portrait.mp4"));
  // No TS loader: preflight must reject the path before loading media modules.
  // This allows OS process startup under concurrent media tests. On macOS the
  // dynamic loader can delay Node before any JS runs; rejection has no timing SLA.
  const startupTimeout = 30_000;
  await assert.rejects(exec(process.execPath, [runner, "--output", output], { cwd: root, timeout: startupTimeout }),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr?: string; signal?: string; killed?: boolean };
      assert.equal(failure.code, 1, JSON.stringify({ code: failure.code, signal: failure.signal, killed: failure.killed, stdout: failure.stdout, stderr: failure.stderr }));
      assert.match(JSON.parse(failure.stdout).message, /non-regular benchmark artifact/u);
      return true;
    });
  assert.equal(await readFile(original, "utf8"), "Private original");
  assert.deepEqual(await readdir(output), ["benchmark-motion-portrait.mp4"]);
  await assert.rejects(exec(process.execPath, [runner, "--output"], { cwd: root, timeout: startupTimeout }),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr?: string; signal?: string; killed?: boolean };
      assert.equal(failure.code, 1, JSON.stringify({ code: failure.code, signal: failure.signal, killed: failure.killed, stdout: failure.stdout, stderr: failure.stderr }));
      assert.match(JSON.parse(failure.stdout).message, /incomplete argument/u);
      return true;
    });
});

test("human corpus separates technical diagnostics from semantic and editorial judgments", () => {
  assert.match(manifest.syntheticLimit, /do not validate speech recognition/u);
  const cases = manifest.humanCases;
  assert.ok(cases.some((item: { language: string }) => item.language !== "en"));
  const idiom = cases.find((item: { id: string }) => item.id === "editorial-work-shutdown");
  assert.match(idiom.authoredSpeech.focus, /couldn't switch off after work/u);
  assert.ok(idiom.authoredSpeech.before && idiom.authoredSpeech.after);
  assert.ok(idiom.stockPair.acceptableQueries.some((query: string) => query.includes("laptop")));
  assert.ok(idiom.stockPair.reject.includes("light switch"));
  const ids = [...manifest.automatedCases, ...cases].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of cases) {
    assert.equal(item.status, "requires-owned-or-licensed-recording");
    assert.ok(item.audience && item.topic && item.intendedTakeaway);
    assert.ok(item.stockPair.tags.length >= 3);
    assert.ok(item.stockPair.portraitRequirement);
    assert.ok(item.stockPair.provenanceRequired.includes("license or permission"));
    assert.ok(item.humanChecks.length >= 4);
  }
  assert.match(manifest.reviewRubric.opening, /new viewer/u);
  assert.match(manifest.reviewRubric.ending, /qualifications/u);
  assert.match(manifest.reviewRubric.attribution, /creator\/source/u);
  assert.match(manifest.reviewRubric.distinctIdea, /headline alone/u);
});
