import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type RemixSettings } from "../shared/types.js";
import { runLocal } from "../server/auto-process.js";
import { probeMedia } from "../server/engine.js";
import { inspectExport } from "../server/quality.js";
import type { SupportingVisual } from "../server/visuals.js";

test("local export checks find broken video and sound while respecting intentional edits", { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remix-quality-"));
  const fixture = async (name: string, video: string, audio?: string, duration = 4) => {
    const output = path.join(directory, `${name}.mp4`);
    await runLocal("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", video,
      ...(audio ? ["-f", "lavfi", "-i", audio] : ["-an"]),
      "-t", String(duration), "-c:v", "libx264", "-threads", "1",
      "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac"] : []), output,
    ]);
    return output;
  };
  const moving = "testsrc2=size=320x180:rate=24";
  const tone = "sine=frequency=440:sample_rate=48000";
  try {
    const valid = await fixture("valid", moving, tone);
    const silentSource = await fixture("no-audio", moving);
    const source = await probeMedia(valid);
    const settings: RemixSettings = { ...DEFAULT_SETTINGS };
    const options = { output: valid, source, settings, signal: new AbortController().signal };
    const codes = (report: Awaited<ReturnType<typeof inspectExport>>) => report.issues.map(issue => issue.code);

    await t.test("motion with audible source audio passes a full timeline check", async () => {
      const report = await inspectExport(options);
      assert.equal(report.status, "pass", JSON.stringify(report));
      assert.deepEqual(report.issues, []);
      assert.equal(report.scope, "full");
      assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
    });

    await t.test("duration and framing mismatches are review issues rather than render failures", async () => {
      const report = await inspectExport({ ...options,
        source: { ...source, duration: 9 },
        settings: { ...settings, aspect: "9:16" },
      });
      assert.equal(report.status, "review");
      assert.ok(codes(report).includes("duration-mismatch"));
      assert.ok(codes(report).includes("dimensions-mismatch"));
      assert.ok(!codes(report).includes("inspection-failed"), JSON.stringify(report));
    });

    await t.test("expected duration follows cuts, trim clamping and playback speed", async () => {
      for (const changed of [
        { segments: [{ start: 2, end: 5 }, { start: 7, end: 10 }], speed: 1.5 },
        { trimStart: 2, trimEnd: 8, speed: 1.5, timeShift: 5 },
        { trimStart: 4, trimEnd: 12, speed: 1.5 },
      ]) {
        const report = await inspectExport({ ...options,
          source: { ...source, duration: 10 }, settings: { ...settings, ...changed },
        });
        assert.equal(report.status, "pass", JSON.stringify(report));
      }
    });

    await t.test("missing or nearly silent audio is detected only when the edit expects audible sound", async () => {
      const missing = await inspectExport({ ...options, output: silentSource });
      assert.equal(missing.status, "review");
      assert.ok(codes(missing).includes("missing-audio"));
      const replacement = await inspectExport({ ...options, output: silentSource,
        source: { ...source, hasAudio: false }, audioPath: "/a-saved-narration-track.wav",
      });
      assert.ok(codes(replacement).includes("missing-audio"));
      const almostSilent = await fixture("almost-silent", moving, `${tone},volume=0.00001`);
      const quiet = await inspectExport({ ...options, output: almostSilent });
      assert.equal(quiet.status, "review");
      assert.ok(codes(quiet).includes("near-silent-audio"), JSON.stringify(quiet));
      for (const intentional of [
        { output: silentSource, source: { ...source, hasAudio: false }, settings },
        { output: silentSource, source, settings: { ...settings, muted: true } },
        { output: silentSource, source, settings: { ...settings, volume: 0 } },
        { output: almostSilent, source, settings: { ...settings, volume: 0 } },
      ]) {
        const report = await inspectExport({ ...options, ...intentional });
        assert.equal(report.status, "pass", JSON.stringify(report));
      }
    });

    const black = await fixture("black", "color=black:size=320x180:rate=24", tone);
    await t.test("black and frozen MP4 intervals carry actionable output timestamps", async () => {
      const still = await fixture("still", `${moving},select=eq(n\\,0),loop=loop=-1:size=1:start=0,setpts=N/24/TB`, tone);
      const freeze = await inspectExport({ ...options, output: still });
      assert.equal(freeze.status, "review");
      const frozen = freeze.issues.find(issue => issue.code === "frozen-frames");
      assert.ok(frozen, JSON.stringify(freeze));
      assert.equal(frozen.start, 0);
      assert.ok(frozen.end! >= 3.5 && frozen.end! <= 4.05);
      const dark = await inspectExport({ ...options, output: black });
      assert.equal(dark.status, "review");
      const interval = dark.issues.find(issue => issue.code === "black-frames");
      assert.ok(interval, JSON.stringify(dark));
      assert.equal(interval.start, 0);
      assert.ok(interval.end! >= 3.5 && interval.end! <= 4.05);
    });

    await t.test("graphic coverage exempts intentional stills but cannot hide black output or missing audio", async () => {
      const graphic: SupportingVisual = { path: "/saved-card.mp4", start: 0, end: 4, sourceStart: 0, label: "Intentional card", kind: "graphic" };
      const visibleCard = await fixture("visible-card", "color=gray:size=320x180:rate=24", tone);
      const intentional = await inspectExport({ ...options, output: visibleCard, supportingVisuals: [graphic] });
      assert.equal(intentional.status, "pass", JSON.stringify(intentional));
      const adjacent = await inspectExport({ ...options, output: visibleCard, supportingVisuals: [
        { ...graphic, end: 2 }, { ...graphic, start: 2 },
      ] });
      assert.equal(adjacent.status, "pass", JSON.stringify(adjacent));
      for (const visual of [{ ...graphic, end: 2 }, { ...graphic, kind: "broll" as const }]) {
        const report = await inspectExport({ ...options, output: visibleCard, supportingVisuals: [visual] });
        assert.equal(report.status, "review");
        assert.ok(codes(report).includes("frozen-frames"));
      }
      const brokenCard = await inspectExport({ ...options, output: black, supportingVisuals: [graphic] });
      assert.equal(brokenCard.status, "review");
      assert.ok(codes(brokenCard).includes("black-frames"), "A planned card cannot excuse entirely black rendered output");
      assert.ok(!codes(brokenCard).includes("frozen-frames"));
      const missingAudio = await fixture("silent-card", "color=gray:size=320x180:rate=24");
      const report = await inspectExport({ ...options, output: missingAudio, supportingVisuals: [graphic] });
      assert.deepEqual(codes(report), ["missing-audio"], "A graphic exception cannot hide missing narration");
    });

    await t.test("long exports use bounded samples and explicitly report limited timeline coverage", async () => {
      const long = await fixture("long", "testsrc2=size=160x90:rate=4", undefined, 184);
      const longSource = await probeMedia(long);
      const report = await inspectExport({ ...options, output: long, source: longSource });
      assert.equal(report.scope, "sampled");
      assert.equal(report.status, "pass", JSON.stringify(report));
    });

    await t.test("inspection failures never pass and caller cancellation propagates", async () => {
      const corrupt = path.join(directory, "corrupt.mp4");
      await writeFile(corrupt, "not an MP4");
      for (const output of [corrupt, path.join(directory, "missing.mp4")]) {
        const report = await inspectExport({ ...options, output });
        assert.equal(report.status, "review");
        assert.ok(codes(report).includes("inspection-failed"));
        assert.ok(!JSON.stringify(report).includes(directory));
        assert.ok(!JSON.stringify(report).includes("ffprobe failed"));
      }
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(inspectExport({ ...options, signal: cancelled.signal }), { name: "AbortError" });
      const active = new AbortController();
      const checking = inspectExport({ ...options, signal: active.signal });
      const timer = setTimeout(() => active.abort(), 20);
      try { await assert.rejects(checking, { name: "AbortError" }); }
      finally { clearTimeout(timer); }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
